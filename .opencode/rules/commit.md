# Commit Message Convention

## Format

```
<scope>: <description> [spec]
```

- **`scope`** — short noun, lowercase. Use only: `docs`, `feat`, `fix`, `refactor`, `test`, `assets`, `ci`. No new scopes without a reason.
- **`description`** — imperative mood, lowercase, no trailing period.
- **`[spec]`** — optional, `[001]` to tag a feature spec. Omit for cross-cutting work (license, CI, constitution).

## Examples

```
docs: add plan for VPS deployment [001]
feat: wire OCR pipeline into agent graph [001]
fix: handle empty receipt response from OCR [001]
refactor: extract discord adapter from agent graph
test: add integration test for shopping-list creation [001]
assets: add app icon
ci: pin node version in dockerfile
```

## No Commit Body

Do not write commit message bodies. The maintainer reads only subject lines, so information in the body is effectively invisible.

If the subject line can't explain the change, split the commit into smaller pieces — each should be describable in one line.

Exception: tool-generated commits (merge, squash) or speckit boilerplate may include a body. That's fine as long as you didn't write it.
