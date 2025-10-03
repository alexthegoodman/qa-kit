# QA Kit

Semi-automated quality assurance system which matches code changes to high quality human curated (often handcrafted) samples in order to flag concerns.

## Features

- Specify how much context to include when evaluating code changes
- Provides specific commentary on potential issues
- Designed to leverage human-level quality alongside agentic efficiency

## How to Use

- Install via npm:

  ```bash
  npm install qa-kit
  ```

- Add `qa.json` configuration file to your project root:

```json
{
  "contextLines": 50,
  "maxDiffLines": 500,
  "maxSnippetMatches": 3,
  "maxDiffsPerRun": 3,
  "ignoreFiles": [
    "quality/**",
    "qa.json",
    "tsconfig.json",
    "package.json",
    "package-lock.json",
    "node_modules/**"
  ]
}
```

- Add high quality code samples to the `quality/` directory in your project root.
  These samples will be used to evaluate code changes. They can be in any language.

- Add the OPENAI_API_KEY to your .env file:

  ```
  OPENAI_API_KEY=your_openai_api_key
  ```

- Run the QA Kit CLI tool:

  ```bash
  npx qa-kit
  ```
