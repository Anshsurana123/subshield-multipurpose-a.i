import { NextResponse } from 'next/server';
import { requireBearerSecret } from '@/lib/auth/server';
import { apiError } from '@/lib/http/errors';
import { claimWorkflowJob, finishWorkflowJob } from '@/lib/workflows/repository';
import { processWorkflowJob } from '@/lib/workflows/processor';

export const dynamic = 'force-dynamic';
export const maxDuration = 240;

type ProcessResult = {
  processed: boolean;
  jobType?: string;
  retryScheduled?: boolean;
};

async function processOneWorkflowJob(): Promise<ProcessResult> {
  const job = await claimWorkflowJob();
  if (!job) return { processed: false };

  try {
    await processWorkflowJob(job);
    await finishWorkflowJob({ id: job.id, leaseToken: job.leaseToken, succeeded: true, retryable: false });
    return { processed: true, jobType: job.jobType };
  } catch {
    const retryScheduled = job.attemptCount < 5;
    await finishWorkflowJob({
      id: job.id,
      leaseToken: job.leaseToken,
      succeeded: false,
      retryable: retryScheduled,
      errorCode: 'WORKFLOW_STEP_FAILED',
    });
    return { processed: false, jobType: job.jobType, retryScheduled };
  }
}

export async function POST(request: Request) {
  try {
    requireBearerSecret(request, 'INTERNAL_WORKER_SECRET');
    const result = await processOneWorkflowJob();
    return NextResponse.json(result, { status: result.retryScheduled ? 503 : 200 });
  } catch (error) {
    return apiError(error, 'Unable to process workflow');
  }
}

export async function GET(request: Request) {
  try {
    requireBearerSecret(request, 'CRON_SECRET');
    const deadline = Date.now() + 210_000;
    let completed = 0;
    let retryScheduled = 0;

    while (completed + retryScheduled < 25 && Date.now() < deadline) {
      const result = await processOneWorkflowJob();
      if (!result.processed && !result.retryScheduled) break;
      if (result.processed) completed += 1;
      if (result.retryScheduled) retryScheduled += 1;
    }

    return NextResponse.json({ completed, retryScheduled });
  } catch (error) {
    return apiError(error, 'Unable to process workflow queue');
  }
}
