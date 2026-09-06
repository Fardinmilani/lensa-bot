// Real Workers runtime (workerd) provides "cloudflare:workers"; plain Node
// doesn't know that URL scheme. This stub supplies just enough of the shape
// (a base class exposing this.env/this.ctx) for Workflow files to import
// cleanly and be structurally checked under `node --test`. It intentionally
// does NOT reimplement step.do()'s durable-execution/retry semantics --
// exercising that end-to-end belongs in `wrangler dev` / real deploys, not
// here. See test/register-loader.mjs for how this gets substituted in.
export class WorkflowEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
