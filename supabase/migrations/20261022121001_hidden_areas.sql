-- Existing ownership and session policies also protect this reversible visibility preference.
ALTER TABLE public.areas ADD COLUMN hidden boolean NOT NULL DEFAULT false;
