ALTER TABLE public.ai_configs DROP CONSTRAINT ai_configs_provider_check;
ALTER TABLE public.ai_configs ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));

ALTER TABLE public.ai_usage_log DROP CONSTRAINT ai_usage_log_provider_check;
ALTER TABLE public.ai_usage_log ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));
