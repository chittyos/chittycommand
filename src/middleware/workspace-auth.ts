/**
 * Hono middleware: verify Google Workspace Add-on HTTP-mode auth payload.
 *
 * Workspace Studio sends an `authorizationEventObject` inside the JSON body
 * of every custom-step invocation. We verify the system ID token (proves the
 * request came from Google's infrastructure) and the user ID token (identifies
 * the end-user), then stash the resolved context on the Hono context for
 * downstream handlers.
 *
 * @canon: chittycanon://core/services/chittycommand/workspace-studio
 */

import type { Context, Next, MiddlewareHandler } from 'hono';
import type { Env } from '../index';
import {
  verifyWorkspaceSystemIdToken,
  verifyWorkspaceUserIdToken,
  WorkspaceJWTError,
} from '../lib/workspace-jwt';

export interface WorkspaceContext {
  user_email: string;
  user_oauth_token: string | null;
  sa_email: string;
}

export type WorkspaceVariables = {
  workspaceContext: WorkspaceContext;
  workspaceBody: Record<string, unknown>;
};

interface AuthorizationEventObject {
  systemIdToken?: string;
  userIdToken?: string;
  userOAuthToken?: string;
}

function googleErrorCard(message: string, code: string) {
  return {
    renderActions: {
      action: {
        notifications: [
          {
            text: `chittycommand auth failed (${code}): ${message}`,
          },
        ],
      },
    },
    error: { code, message },
  };
}

export function workspaceAuth(): MiddlewareHandler<{
  Bindings: Env;
  Variables: WorkspaceVariables;
}> {
  return async (c: Context<{ Bindings: Env; Variables: WorkspaceVariables }>, next: Next) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json(googleErrorCard('Body is not valid JSON', 'BAD_BODY'), 400);
    }

    const authEvt = (body.authorizationEventObject ?? {}) as AuthorizationEventObject;
    const systemIdToken = authEvt.systemIdToken;
    const userIdToken = authEvt.userIdToken;
    const userOAuthToken = authEvt.userOAuthToken ?? null;

    if (!systemIdToken || !userIdToken) {
      return c.json(
        googleErrorCard(
          'authorizationEventObject must include systemIdToken and userIdToken',
          'TOKENS_MISSING',
        ),
        401,
      );
    }

    try {
      const sysClaims = await verifyWorkspaceSystemIdToken(systemIdToken, c.env);
      const userClaims = await verifyWorkspaceUserIdToken(userIdToken, c.env);

      c.set('workspaceContext', {
        user_email: userClaims.email,
        user_oauth_token: userOAuthToken,
        sa_email: sysClaims.email,
      });
      c.set('workspaceBody', body);
    } catch (err) {
      if (err instanceof WorkspaceJWTError) {
        return c.json(googleErrorCard(err.message, err.code), 401);
      }
      return c.json(googleErrorCard(String(err), 'AUTH_UNKNOWN'), 401);
    }
    return next();
  };
}
