-- Demo users (create in Supabase Dashboard -> Authentication -> Users first)
-- Then run this SQL in Supabase SQL Editor to set profiles + roles/sides.
--
-- 1) DEMO SUPER ADMIN (internal testing)
-- email: demo.admin@taskwheels.com
-- 2) DEMO AUDITOR
-- email: demo.auditor@taskwheels.com
--
-- Notes:
-- - No passwords are stored here. Set strong passwords in Auth UI.
-- - Side is canonical AUDITOR, but if your DB still uses legacy OPERATOR, switch 'AUDITOR' -> 'OPERATOR' below.

-- DEMO SUPER ADMIN
update public.profiles p
set
  full_name = coalesce(p.full_name, 'Demo Super Admin'),
  role = 'super_admin',
  side = 'FNU',
  is_active = true
from auth.users u
where p.id = u.id
  and u.email = 'demo.admin@taskwheels.com';

-- DEMO AUDITOR
update public.profiles p
set
  full_name = coalesce(p.full_name, 'Demo Auditor'),
  role = 'user_operator',
  side = 'AUDITOR',
  is_active = true
from auth.users u
where p.id = u.id
  and u.email = 'demo.auditor@taskwheels.com';

