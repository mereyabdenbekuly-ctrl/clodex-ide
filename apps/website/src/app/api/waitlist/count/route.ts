import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const apiKey = process.env.WAITLISTER_API_KEY;
  const waitlistKey = process.env.WAITLISTER_WAITLIST_KEY;

  if (!apiKey || !waitlistKey) {
    return NextResponse.json(
      { error: 'Waitlister credentials not configured' },
      { status: 500 },
    );
  }

  try {
    const response = await fetch(
      `https://waitlister.me/api/v1/waitlist/${waitlistKey}/subscribers?limit=1`,
      {
        headers: {
          'X-Api-Key': apiKey,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Waitlister API error: ${response.status}`);
    }

    const data = await response.json();

    return NextResponse.json({
      total: data.data.total,
    });
  } catch (error) {
    console.error('Error fetching waitlist count:', error);
    return NextResponse.json(
      { error: 'Failed to fetch waitlist count' },
      { status: 500 },
    );
  }
}
