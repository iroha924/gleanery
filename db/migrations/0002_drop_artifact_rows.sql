-- Deletes the requirements and design sources. Their children (document sections, their files, and full-text index entries) are cleaned up
-- by the foreign keys' on delete cascade and the knowledge delete trigger. 0003 removes the kinds from the CHECK.
delete from source_item where kind in ('requirements', 'design');
