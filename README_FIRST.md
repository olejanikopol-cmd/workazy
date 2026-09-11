# Start here

1. Put this folder's Markdown files in the root of the Workazy repository.
2. Put the `references/` folder in the repository root as well.
3. Open the repository in the coding harness/agent.
4. Give it this instruction:

```text
Read MASTER_PROMPT.md and execute tasks/mobile-migration.md autonomously.
Use HARNESS.md for role switching.
Treat AGENTS.mobile.md as mandatory rules.
Use all images in references/ as visual source of truth.
Continue until the Definition of Done is satisfied or a real external blocker requires me.
```

Recommended repository strategy:
- keep existing web app intact
- build new native app in `/mobile`
- use a branch such as `feat/native-ios`
- commit after each accepted slice

The first external actions that may eventually require the user:
- installing/launching Xcode
- iOS simulator/device permissions
- Apple signing when moving beyond simulator/local development
- any server secret not already available to the environment
