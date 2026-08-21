import { withAuth } from 'next-auth/middleware';
import { NextResponse } from 'next/server';

/**
 * Route protection.
 *
 * Pages redirect to /login. API routes are deliberately NOT redirected — an
 * API client asking for JSON should get a JSON 401, not an HTML login page, so
 * those fall through to each route's own `requireAuth()`.
 */
export default withAuth(
  function middleware() {
    return NextResponse.next();
  },
  {
    pages: {
      signIn: '/login',
    },
    callbacks: {
      authorized: ({ token, req }) => {
        // Let API routes through so they can answer with a proper JSON 401.
        if (req.nextUrl.pathname.startsWith('/api/')) return true;
        return Boolean(token);
      },
    },
  },
);

export const config = {
  matcher: [
    '/((?!api/auth|api/health|api/webhooks|login|_next/static|_next/image|favicon.ico).*)',
  ],
};
