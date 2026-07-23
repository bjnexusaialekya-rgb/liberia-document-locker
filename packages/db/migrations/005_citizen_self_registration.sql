-- 005_citizen_self_registration.sql
-- Closes the gap flagged in 003_rls_foundation.sql's users_insert_by_admin_or_supervisor
-- comment: a brand-new citizen has no session yet (app.current_user_id is null),
-- so no RLS policy keyed on "who is the caller" can cover their first INSERT into
-- users. This adds a single SECURITY DEFINER function as the only path for that
-- insert, instead of widening locker_app's INSERT grant or RLS policy — the
-- attack surface is this one function's body, not a policy condition.
--
-- Scope boundary (deliberate, not an oversight): this function only performs the
-- INSERT once its caller has already confirmed identity. It does NOT perform NIR
-- verification, OTP confirmation, or passport/voter-ID fallback matching itself —
-- that sequencing is auth's actual registration flow (not yet built) and must not
-- be guessed here. auth calls this function only after its own verification step
-- succeeds. If auth's real flow needs additional atomic writes at registration
-- time (e.g. an initial audit-log entry in the same transaction), extend this
-- function rather than reaching for a second INSERT grant or role.

CREATE OR REPLACE FUNCTION register_citizen(
  p_full_name          text,
  p_national_id_number citext DEFAULT NULL,
  p_phone_number       text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
BEGIN
  IF btrim(coalesce(p_full_name, '')) = '' THEN
    RAISE EXCEPTION 'register_citizen: full_name is required' USING ERRCODE = '23514';
  END IF;

  INSERT INTO users (user_type, full_name, national_id_number, phone_number)
  VALUES ('CITIZEN', btrim(p_full_name), p_national_id_number, p_phone_number)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- Ownership matters here, not just the SECURITY DEFINER keyword: this function
-- must be owned by the migration/table-owner role (whoever runs this file),
-- never by locker_app — otherwise SECURITY DEFINER grants no more privilege
-- than locker_app already had. CREATE FUNCTION already assigns ownership to
-- the connecting (owner) role, so no separate ALTER FUNCTION ... OWNER TO
-- is needed as long as this migration is run by the same owner role as 002-004.

-- locker_app gets EXECUTE on this one function only — not a broader INSERT
-- grant on users. This is the entire attack surface for citizen self-registration.
GRANT EXECUTE ON FUNCTION register_citizen(text, citext, text) TO locker_app;
