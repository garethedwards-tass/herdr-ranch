---
name: herdr-ranch-review-last
description: Open your latest message for review in Herdr (the Reviews mod, beside your pane) and use the returned comments to revise it or continue.
allowed-tools: Bash(ranch-review:*)
disable-model-invocation: true
---

# Herdr Ranch Review Last

## Review

!`ranch-review last $ARGUMENTS`

## Your task

A review can take longer than two minutes. If the output above says the command was moved to the background, wait for its completion notification and read its output file; that output is the answer. Don't start the command again.

The output will be one of:

1. The exact text `The user approved.` The user approved your last message as it is. Acknowledge with one sentence ("Approved.") and stop. Do not begin any work.
2. Empty. The user discarded the review. Acknowledge with one sentence ("Review discarded.") and stop. Do not begin any work.
3. Feedback starting with `# Message Feedback`. Address it: the user reviewed your last message and left comments on specific parts of it.
4. A `ranch-review:` error saying the last message can't be read (an agent other than Claude Code or Codex). Run `ranch-review last --stdin` yourself with your last message on stdin, then handle its output as in 1 to 3.
