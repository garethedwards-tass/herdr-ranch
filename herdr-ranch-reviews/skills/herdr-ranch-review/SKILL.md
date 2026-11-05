---
name: herdr-ranch-review
description: Open a Markdown file for review in Herdr (the Reviews mod, beside your pane) and then respond to the returned comments.
allowed-tools: Bash(ranch-review:*)
disable-model-invocation: true
---

# Herdr Ranch Review

## Review

!`ranch-review annotate $ARGUMENTS`

## Your task

A review can take longer than two minutes. If the output above says the command was moved to the background, wait for its completion notification and read its output file; that output is the answer. Don't start the command again.

The output will be one of:

1. The exact text `The user approved.` The user approved the file as it is. Acknowledge with one sentence ("Approved.") and stop. Do not begin any work.
2. Empty. The user discarded the review. Acknowledge with one sentence ("Review discarded.") and stop. Do not begin any work.
   `A newer review of the same document replaced this one.` means the same: a later review of it took over. Acknowledge with one sentence and stop.
3. Feedback starting with `# File Feedback`. Address it: the user reviewed the file and left comments on specific lines.
4. A `ranch-review:` error saying the file can't be read. The user described what to review in their own words: work out which Markdown file they mean, run `ranch-review annotate <path>` yourself, then handle its output as in 1 to 3.
