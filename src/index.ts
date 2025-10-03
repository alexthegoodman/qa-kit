#!/usr/bin/env node

import * as dotenv from "dotenv";
import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

dotenv.config();

const execAsync = promisify(exec);

export interface QAConfig {
  contextLines: number; // number of lines of context to include around changes
  maxDiffLines: number; // maximum number of lines to include in a single diff
  maxSnippetMatches: number; // maximum number of snippet matches to return per diff
  maxDiffsPerRun: number; // maximum number of diffs to process in a single run
  ignoreFiles: string[]; // file patterns to ignore during analysis
}

const defaultQAConfig: QAConfig = {
  contextLines: 50,
  maxDiffLines: 500,
  maxSnippetMatches: 3,
  maxDiffsPerRun: 3,
  ignoreFiles: ["quality/**", "qa.json"],
};

interface Snippet {
  name: string;
  content: string;
}

interface DiffInfo {
  file: string;
  diff: string;
}

interface SnippetMatch {
  snippetName: string;
  relevanceScore: number;
}

interface QAResult {
  file: string;
  status: "accepted" | "warning" | "rejected";
  matches: Array<{
    snippetName: string;
    commentary: string;
  }>;
}

// Load qa.json config and merge with defaults
async function loadConfig(): Promise<QAConfig> {
  try {
    const configPath = path.join(process.cwd(), "qa.json");
    const configFile = await fs.readFile(configPath, "utf-8");
    const userConfig = JSON.parse(configFile);
    return { ...defaultQAConfig, ...userConfig };
  } catch (error) {
    console.info("No qa.json found, using default configuration");
    return defaultQAConfig;
  }
}

// Load all snippets from /quality directory
async function loadSnippets(): Promise<Snippet[]> {
  const qualityDir = path.join(process.cwd(), "quality");

  try {
    await fs.access(qualityDir);
  } catch (error) {
    console.warn("No /quality directory found. Creating one...");
    await fs.mkdir(qualityDir, { recursive: true });
    return [];
  }

  const files = await fs.readdir(qualityDir);
  const snippets: Snippet[] = [];

  for (const file of files) {
    const filePath = path.join(qualityDir, file);
    const stat = await fs.stat(filePath);

    if (stat.isFile()) {
      const content = await fs.readFile(filePath, "utf-8");
      snippets.push({
        name: file,
        content,
      });
    }
  }

  return snippets;
}

// Get git diffs for changed files
async function getGitDiffs(
  contextLines: number,
  ignorePatterns: string[]
): Promise<DiffInfo[]> {
  try {
    // Get list of changed files
    const { stdout: statusOutput } = await execAsync("git status --porcelain");

    if (!statusOutput.trim()) {
      console.info("No changes detected");
      return [];
    }

    // Get unified diff with context (tracked files)
    const { stdout: diffOutput } = await execAsync(
      `git diff --unified=${contextLines} HEAD`
    );

    // Get untracked files
    const { stdout: untrackedOutput } = await execAsync(
      `git ls-files --others --exclude-standard`
    );

    // Parse diffs per file
    const diffs: DiffInfo[] = [];
    const diffSections = diffOutput.split(/^diff --git/m).slice(1);

    for (const section of diffSections) {
      const fileMatch = section.match(/a\/(.*?) b\//);
      if (fileMatch) {
        const filePath = fileMatch[1];

        // Check if file should be ignored
        const shouldIgnore = ignorePatterns.some((pattern) => {
          // Convert glob pattern to regex
          const regexPattern = pattern
            .replace(/\./g, "\\.")
            .replace(/\*\*/g, ".*")
            .replace(/\*/g, "[^/]*");
          return new RegExp(`^${regexPattern}$`).test(filePath);
        });

        if (!shouldIgnore) {
          diffs.push({
            file: filePath,
            diff: "diff --git" + section,
          });
        }
      }
    }

    // Add untracked files
    const untrackedFiles = untrackedOutput.trim().split("\n").filter(Boolean);
    for (const filePath of untrackedFiles) {
      // Check if file should be ignored
      const shouldIgnore = ignorePatterns.some((pattern) => {
        const regexPattern = pattern
          .replace(/\./g, "\\.")
          .replace(/\*\*/g, ".*")
          .replace(/\*/g, "[^/]*");
        return new RegExp(`^${regexPattern}$`).test(filePath);
      });

      if (!shouldIgnore) {
        // Read the entire file content as a diff
        try {
          const content = await fs.readFile(
            path.join(process.cwd(), filePath),
            "utf-8"
          );
          const lines = content
            .split("\n")
            .map((line, i) => `+${line}`)
            .join("\n");
          diffs.push({
            file: filePath,
            diff: `diff --git a/${filePath} b/${filePath}\nnew file\n--- /dev/null\n+++ b/${filePath}\n${lines}`,
          });
        } catch (error) {
          console.warn(`Could not read untracked file ${filePath}`);
        }
      }
    }

    return diffs;
  } catch (error) {
    console.error("Error getting git diffs:", error);
    return [];
  }
}

// Match snippets to a diff using OpenAI
async function matchSnippetsToDiff(
  diff: DiffInfo,
  snippets: Snippet[],
  maxMatches: number
): Promise<SnippetMatch[]> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable not set");
  }

  const snippetList = snippets.map((s) => s.name).join(", ");

  const prompt = `You are a code quality analyst. Given the following code diff and a list of quality snippet names, identify which snippets are most relevant to review this change.

Code Diff:
${diff.diff}

Available Quality Snippets:
${snippetList}

Return up to ${maxMatches} snippet names that are most relevant to this diff, with a relevance score (0-100). Return ONLY valid JSON in this exact format:
[{"snippetName": "example.js", "relevanceScore": 95}]`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      }),
    });

    const data = await response.json();
    const content = data.choices[0].message.content;

    // Extract JSON from response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return [];
  } catch (error) {
    console.error(`Error matching snippets for ${diff.file}:`, error);
    return [];
  }
}

// Analyze a match and provide commentary
async function analyzeMatch(
  diff: DiffInfo,
  snippet: Snippet
): Promise<{
  commentary: string;
  status: "accepted" | "warning" | "rejected";
}> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable not set");
  }

  const prompt = `You are a code quality analyst. Compare this code diff against a quality snippet to identify potential issues.

Code Diff:
${diff.diff}

Quality Snippet (${snippet.name}):
${snippet.content}

Analyze if the changes in the diff align with or violate the quality standards shown in the snippet. Provide:
1. A brief commentary on the match
2. A status: "accepted" (no issues), "warning" (minor concerns), or "rejected" (significant issues)

Return ONLY valid JSON in this exact format:
{"commentary": "your analysis here", "status": "accepted"}`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      }),
    });

    const data = await response.json();
    const content = data.choices[0].message.content;

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return {
      commentary: "Unable to parse analysis",
      status: "warning",
    };
  } catch (error) {
    console.error(`Error analyzing match for ${diff.file}:`, error);
    return {
      commentary: `Error during analysis: ${error}`,
      status: "warning",
    };
  }
}

async function main() {
  const args = process.argv.slice(2);

  console.info("Initializing QA Kit... 🚀");
  console.info("detected args: ", args);

  // Load configuration
  const config = await loadConfig();
  console.info(`Configuration loaded: ${JSON.stringify(config)}`);

  // Load snippets
  const snippets = await loadSnippets();
  console.info(`Loaded ${snippets.length} quality snippets`);

  if (snippets.length === 0) {
    console.warn(
      "No snippets found in /quality directory. Please add some quality samples."
    );
    return;
  }

  // Get git diffs
  const diffs = await getGitDiffs(config.contextLines, config.ignoreFiles);
  console.info(`Found ${diffs.length} changed files`);

  if (diffs.length === 0) {
    console.info("No changes to analyze");
    return;
  }

  // Limit diffs to process
  const diffsToProcess = diffs.slice(0, config.maxDiffsPerRun);
  const results: QAResult[] = [];

  // Process each diff
  for (const diff of diffsToProcess) {
    console.info(`\nAnalyzing ${diff.file}...`);

    // Truncate diff if too long
    let diffContent = diff.diff;
    const diffLines = diffContent.split("\n");
    if (diffLines.length > config.maxDiffLines) {
      diffContent =
        diffLines.slice(0, config.maxDiffLines).join("\n") +
        "\n... (truncated)";
      diff.diff = diffContent;
    }

    // Match snippets
    const matches = await matchSnippetsToDiff(
      diff,
      snippets,
      config.maxSnippetMatches
    );
    console.info(`  Found ${matches.length} relevant snippets`);

    // Analyze each match
    const matchResults = [];
    let overallStatus: "accepted" | "warning" | "rejected" = "accepted";

    for (const match of matches) {
      const snippet = snippets.find((s) => s.name === match.snippetName);
      if (!snippet) continue;

      console.info(
        `  Analyzing against ${snippet.name}... Relevance Score: ${match.relevanceScore}`
      );

      if (match.relevanceScore < 80) {
        console.info(
          `    Skipping low relevance match (${match.relevanceScore})`
        );
        continue;
      }

      const analysis = await analyzeMatch(diff, snippet);

      matchResults.push({
        snippetName: snippet.name,
        commentary: analysis.commentary,
      });

      // Update overall status (rejected > warning > accepted)
      if (analysis.status === "rejected") {
        overallStatus = "rejected";
      } else if (
        analysis.status === "warning" &&
        overallStatus !== "rejected"
      ) {
        overallStatus = "warning";
      }
    }

    results.push({
      file: diff.file,
      status: overallStatus,
      matches: matchResults,
    });
  }

  // Output results
  console.info("\n" + "=".repeat(60));
  console.info("QA RESULTS");
  console.info("=".repeat(60) + "\n");

  let acceptedCount = 0;
  let warningCount = 0;
  let rejectedCount = 0;

  for (const result of results) {
    const statusIcon =
      result.status === "accepted"
        ? "✅"
        : result.status === "warning"
        ? "⚠️"
        : "❌";

    console.info(
      `${statusIcon} ${result.file} - ${result.status.toUpperCase()}`
    );

    for (const match of result.matches) {
      console.info(`   📝 ${match.snippetName}`);
      console.info(`      ${match.commentary}`);
    }
    console.info("");

    if (result.status === "accepted") acceptedCount++;
    else if (result.status === "warning") warningCount++;
    else rejectedCount++;
  }

  // Summary
  console.info("=".repeat(60));
  console.info("SUMMARY");
  console.info("=".repeat(60));
  console.info(`Total files analyzed: ${results.length}`);
  console.info(`✅ Accepted: ${acceptedCount}`);
  console.info(`⚠️  Warnings: ${warningCount}`);
  console.info(`❌ Rejected: ${rejectedCount}`);

  console.info("\nQuality Checks Completed. ✅");

  // Exit with error if any rejections
  if (rejectedCount > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
