import { NextResponse } from 'next/server';
import { requireSameOrigin, requireUser } from '@/lib/auth/server';
import { apiError } from '@/lib/http/errors';
import { PayloadTooLargeError, readLimitedBody } from '@/lib/http/request-safety';
import { createChannelLinkRequest, listLinkedChannels, unlinkChannel } from '@/lib/channels/linking';
import type { ChannelProvider } from '@/lib/channels/repository';

export const dynamic = 'force-dynamic';

function provider(value: unknown): ChannelProvider | null {
  return value === 'telegram' || value === 'linq' ? value : null;
}

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ channels: await listLinkedChannels(user.id) });
  } catch (error) {
    return apiError(error, 'Unable to read linked channels');
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const body = JSON.parse(await readLimitedBody(request, 4 * 1024));
    const selectedProvider = provider(body?.provider);
    if (!selectedProvider) return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
    const link = await createChannelLinkRequest(user.id, selectedProvider);
    return NextResponse.json({
      provider: selectedProvider,
      command: `/link ${link.code}`,
      expiresAt: link.expiresAt,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SyntaxError) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    return apiError(error, 'Unable to create channel link');
  }
}

export async function DELETE(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const body = JSON.parse(await readLimitedBody(request, 4 * 1024));
    const selectedProvider = provider(body?.provider);
    if (!selectedProvider) return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
    await unlinkChannel(user.id, selectedProvider);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SyntaxError) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    return apiError(error, 'Unable to unlink channel');
  }
}
