import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, Server as HttpServer } from "node:http";

import { Server as SocketIOServer } from "socket.io";

import { normalizeApplicationOrigin } from "../auth/security.js";
import type { AuthenticationSeam } from "../account/seams.js";
import {
  organizationAccessRevokedEvent,
  organizationInvalidationEvent,
  type OrganizationAccessRevokedPayload,
  type OrganizationInvalidationPayload,
} from "./events.js";
import {
  createOrganizationRealtimePublisher,
  type OrganizationRealtimeAudience,
  type OrganizationRealtimePublisher,
} from "./publisher.js";
import {
  authorizeOrganizationHandshake,
  joinAuthorizedOrganizationRoom,
  type AuthorizedOrganizationHandshake,
  type RealtimeAccessResolver,
} from "./rooms.js";

type ClientToServerEvents = Record<never, never>;
type InterServerEvents = Record<never, never>;

interface ServerToClientEvents {
  [organizationAccessRevokedEvent]: (payload: OrganizationAccessRevokedPayload) => void;
  [organizationInvalidationEvent]: (payload: OrganizationInvalidationPayload) => void;
}

interface OrganizationSocketData {
  authorization?: AuthorizedOrganizationHandshake;
}

export interface OrganizationHandshakeSocket {
  readonly data: OrganizationSocketData;
  readonly handshake: { readonly headers: IncomingHttpHeaders };
  disconnect(close: boolean): unknown;
  join(room: string): Promise<void> | void;
}

export interface OrganizationSocketRegistrationPort {
  onConnection(listener: (socket: OrganizationHandshakeSocket) => void): void;
  use(
    middleware: (
      socket: OrganizationHandshakeSocket,
      next: (error?: Error) => void,
    ) => Promise<void> | void,
  ): void;
}

type OrganizationSocketServer = SocketIOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  OrganizationSocketData
>;

export interface OrganizationRealtimeDependencies {
  readonly applicationOrigin: string;
  readonly authentication: AuthenticationSeam;
  readonly resolveAccess: RealtimeAccessResolver;
}

export interface OrganizationRealtimeServerHandle {
  readonly publisher: OrganizationRealtimePublisher;
  close(): Promise<void>;
}

export type RealtimeRequestIdFactory = () => string;

export function isAllowedRealtimeOrigin(
  originHeader: string | readonly string[] | undefined,
  applicationOriginValue: string,
): boolean {
  if (typeof originHeader !== "string") return false;
  try {
    return (
      normalizeApplicationOrigin(originHeader) ===
      normalizeApplicationOrigin(applicationOriginValue)
    );
  } catch {
    return false;
  }
}

function createSocketIoAudience(io: OrganizationSocketServer): OrganizationRealtimeAudience {
  return {
    emitInvalidation(room, payload) {
      void io.to(room).emit(organizationInvalidationEvent, payload);
    },
    async socketsIn(room) {
      const sockets = await io.in(room).fetchSockets();
      return sockets.flatMap((socket) => {
        const authorization = socket.data.authorization;
        if (authorization === undefined) return [];
        return [
          {
            authorization,
            disconnect() {
              void socket.disconnect(true);
            },
            emitAccessRevoked(payload: OrganizationAccessRevokedPayload) {
              void socket.emit(organizationAccessRevokedEvent, payload);
            },
            async leaveRoom(roomToLeave: string) {
              void socket.leave(roomToLeave);
            },
          },
        ];
      });
    },
  };
}

export function registerOrganizationRealtimeHandlers(
  registration: OrganizationSocketRegistrationPort,
  dependencies: Pick<OrganizationRealtimeDependencies, "authentication" | "resolveAccess">,
  requestIdFactory: RealtimeRequestIdFactory = randomUUID,
): void {
  registration.use(async (socket, next) => {
    try {
      const authorization = await authorizeOrganizationHandshake(
        dependencies.authentication,
        dependencies.resolveAccess,
        socket.handshake.headers.cookie,
        requestIdFactory(),
      );
      if (authorization === null) {
        next(new Error("realtime authentication failed"));
        return;
      }
      socket.data.authorization = authorization;
      next();
    } catch {
      next(new Error("realtime authentication failed"));
    }
  });

  registration.onConnection((socket) => {
    const authorization = socket.data.authorization;
    if (authorization === undefined) {
      void socket.disconnect(true);
      return;
    }
    void joinAuthorizedOrganizationRoom(socket, authorization).catch(() => {
      void socket.disconnect(true);
    });
  });
}

export function createOrganizationRealtimeServer(
  httpServer: HttpServer,
  dependencies: OrganizationRealtimeDependencies,
): OrganizationRealtimeServerHandle {
  const applicationOrigin = normalizeApplicationOrigin(dependencies.applicationOrigin);
  const io: OrganizationSocketServer = new SocketIOServer(httpServer, {
    allowRequest(request, callback) {
      callback(null, isAllowedRealtimeOrigin(request.headers.origin, applicationOrigin));
    },
    connectTimeout: 10_000,
    maxHttpBufferSize: 16_384,
    path: "/socket.io",
    perMessageDeflate: false,
    serveClient: false,
  });

  registerOrganizationRealtimeHandlers(
    {
      onConnection(listener) {
        io.on("connection", listener);
      },
      use(middleware) {
        io.use((socket, next) => {
          void middleware(socket, next);
        });
      },
    },
    dependencies,
  );

  return Object.freeze({
    async close() {
      await io.close();
    },
    publisher: createOrganizationRealtimePublisher(createSocketIoAudience(io)),
  });
}
