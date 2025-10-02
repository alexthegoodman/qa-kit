#!/usr/bin/env node

export interface QAConfig {
  contextLines: number; // number of lines of context to include around changes
  maxDiffLines: number; // maximum number of lines to include in a single diff
  maxSnippetMatches: number; // maximum number of snippet matches to return per diff
}

const defaultQAConfig: QAConfig = {
  contextLines: 50,
  maxDiffLines: 500,
  maxSnippetMatches: 3,
};

async function main() {
  const args = process.argv.slice(2);

  console.info("Initializing QA Kit... 🚀");
  console.info("detected args: ", args);

  // find qa-kit JSON config file in runtime directory, merge with defaults
  // find the /quality directory, load all snippets (could be any language), where the file name is the snippet name
  // find which files have changed via git, collect their diffs
  // provide all snippet names (up to 100 for now) to OpenAI, alone with one diff at a time, and ask it to match snippets to diffs
  // Then, for each diff, and each snippet match, ask OpenAI to provide commentary on the match, and whether it is a concern or not
  // output either "accepted", "warning", or "rejected" for each diff, along with the commentary

  console.info("QA Kit completed. ✅");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
