#!/usr/bin/env node
/**
 * Git post-commit backstop. Cursor cannot see commits made in an external
 * terminal; this only prints a reminder. It does not invoke AI or edit files.
 */
const msg =
  '\n[mendwise docs] source files changed — run the docs-check in Cursor (`node .cursor/hooks/docs-check.mjs`) or re-open Composer to refresh docs-site. This hook cannot update docs by itself.\n';
process.stdout.write(msg);
