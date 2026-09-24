---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.mjs"
  - "**/*.css"
  - "**/*.sql"
  - "**/*.yml"
  - "**/*.yaml"
  - "**/.gitignore"
---

# Comments

- 1 to 3 lines. Put longer explanations in a Skill or design doc and point to its path <!-- invariant: comment-length -->
- At most one bold phrase per file
- In config files, do not write what the setting itself says. Write only the outside context the file cannot show (where it is generated from, why it does not rely on a global setting)
- Delete stale comments in a file you touch, in the same change
