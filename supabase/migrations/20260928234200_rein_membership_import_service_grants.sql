-- The admin Campfire CSV import uses a service-role PostgREST client.
-- Grant only the table operations that its preview and apply paths require.
grant select, insert, update on table public.rein_memberships to service_role;
grant select on table public.rein_plan_catalog to service_role;
