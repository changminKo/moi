-- Fill history, part 4: validate the pairing.
--
-- `validate constraint` scans the table under ShareUpdateExclusiveLock, which
-- blocks neither readers nor writers. Doing it here rather than in 006 keeps
-- the scan off the AccessExclusiveLock that adding the constraint required.
set lock_timeout = '3s';

alter table fills validate constraint fills_order_session_fkey;
