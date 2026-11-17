-- VITICO upgrade: approving an account in the website also confirms its email address,
-- so a customer can log in as soon as you approve them. Run once in SQL Editor.

create or replace function public.confirm_on_access() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  -- A login that has been linked to a customer, or made a rep or admin, has been
  -- checked by VITICO, so it no longer needs to confirm its email address.
  if new.customer_id is not null or new.role in ('rep','admin') then
    update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = new.id;
  end if;
  return new;
end $$;
revoke execute on function public.confirm_on_access() from public, anon, authenticated;

drop trigger if exists on_profile_access_granted on public.profiles;
create trigger on_profile_access_granted after update of customer_id, role on public.profiles
  for each row execute function public.confirm_on_access();

-- Logins you have already approved or linked.
update auth.users u set email_confirmed_at = now()
from public.profiles p
where p.id = u.id and u.email_confirmed_at is null
  and (p.customer_id is not null or p.role in ('rep','admin'));
