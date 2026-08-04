# PureWire adult-platform blocklist feeds

Categorized domain lists enforced by the blocklist engine
(`src/convex/blocklist.ts` + the `blockedDomains` table). Every domain here
is rejected — or routed to human review — across posts, comments, stories,
profile bios/links, and pre-encryption DMs.

## Files

| File | Category | Source in code |
| --- | --- | --- |
| `creator-domains.txt` | `adult_creator` | `BANNED_ADULT_HOSTS.adult_subscription` |
| `porn-domains.txt` | `adult_porn` | `BANNED_ADULT_HOSTS.adult_tube` |
| `cam-domains.txt` | `adult_cam` | `BANNED_ADULT_HOSTS.adult_cams` |
| `clip-domains.txt` | `adult_clips` | `BANNED_ADULT_HOSTS.adult_clips` |
| `chat-domains.txt` | `adult_chat` | `BANNED_ADULT_HOSTS.adult_chat` |
| `escort-domains.txt` | `adult_escort` | `BANNED_ADULT_HOSTS.adult_escorts` |
| `fetish-domains.txt` | `adult_fetish` | reserved (empty) |
| `community-domains.txt` | `adult_community` | `BANNED_ADULT_HOSTS.adult_social` |
| `redirects-domains.txt` | `adult_redirect` | `BANNED_ADULT_HOSTS.adult_link_redirect` (reserved, empty) |

## Format

One domain per line, lowercased, no scheme/path/port. Lines starting with
`#` are ignored; the `# Category: <name>` header tells the sync parser
which bucket the entries belong to (so a feed synced from here lands with
its real category instead of defaulting to `adult_other`).

## Keeping them in sync

These files are **generated** from the curated static list in
`src/convex/phishing.ts` (`BANNED_ADULT_HOSTS`), so the shipped data can
never drift from the code that enforces it. To regenerate after editing
the code list:

```bash
npm run data:sync
```

## Using them as external feeds

Each file can be registered in the Admin → Blocklist → External sources
panel as a `domain`-format source pointing at its hosted URL (e.g.
`https://raw.githubusercontent.com/MelroseSaint/global-studio-chat/main/data/adult/creator-domains.txt`),
then synced. Entries imported from a feed carry the feed's name as their
source and a 0.6 confidence — lower than the curated core list (1.0),
and never allowed to override a core entry.
