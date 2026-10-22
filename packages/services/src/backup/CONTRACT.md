# Backup lifecycle

One profile owner admits backup, restore and deletion through the existing execution lock.
This module has no timer. Git and provider adapters supply authoritative snapshots; storage
adapters share immutable encrypted artifacts, completion markers and exact deletion paths.
Only completed copies advance content checkpoints. Each location is independent. UI receives
sanitized summaries and revision-bound restore previews, never credential snapshots.

Cloud discovery is reconstructible without a local index. Restore downloads and authenticates
the complete artifact before admitting source writes. A tombstone makes interrupted deletions
invisible; retries delete only the exact immutable version objects. Retention is scoped by
writer, kind, target and selection. Local file locks never claim to coordinate other computers.

Provider transactions and Git staging belong to injected source ports. All source mutations
must enforce revision checks and rollback. New-directory Git restore never overwrites a
workspace. v1 compatibility is explicitly unauthenticated and must validate every entry.
