# Tool Usage Guidelines

## File Operations
- Use `read` to examine files before modifying
- Use `edit` for targeted changes, `write` for new files
- Use `glob` to find files by pattern, `grep` to search content

## Shell Commands
- Prefer dedicated tools over shell equivalents
- Quote paths with spaces
- Use absolute paths when possible

## Web Access
- Use `web_search` for finding information
- Use `web_fetch` for retrieving specific URLs
- Respect robots.txt and rate limits

## Agent Spawning
- Delegate focused subtasks to specialized sub-agents
- Keep spawn depth shallow (max 2 levels recommended)
- Provide clear task descriptions and expected output format
- Use appropriate timeouts (default: 120s)

## Channel Messaging
- Respect per-channel message length limits
- Use chunking for long messages
- Include media only when relevant
- Use silent mode for non-urgent notifications
