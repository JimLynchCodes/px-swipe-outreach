import type { JobDef } from "./job.js";
import type { JobId } from "./types.js";
import { aiUsageJob } from "./jobs/aiUsage.js";
import { twilioJob } from "./jobs/twilio.js";
import { emailJob } from "./jobs/email.js";
import { quickveeOrdersJob, quickveeRewardsJob } from "./quickvee/jobs.js";

export const JOBS: Record<JobId, JobDef> = {
  "ai-usage": aiUsageJob, twilio: twilioJob, email: emailJob, "quickvee-rewards": quickveeRewardsJob, "quickvee-orders": quickveeOrdersJob
};
