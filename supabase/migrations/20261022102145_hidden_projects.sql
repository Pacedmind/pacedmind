-- Visibility is a reversible planner preference. Existing ownership and session policies apply.
ALTER TABLE public.projects ADD COLUMN hidden boolean NOT NULL DEFAULT false;
