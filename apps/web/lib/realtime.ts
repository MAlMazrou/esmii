"use client";

import { io } from "socket.io-client";
import { useEffect } from "react";

import { organizationRefetchEvent } from "./events";

interface OrganizationInvalidation {
  version: string;
}

function isOrganizationInvalidation(value: unknown): value is OrganizationInvalidation {
  if (typeof value !== "object" || value === null) return false;
  const version = Reflect.get(value, "version");
  return typeof version === "string" && version.length > 0 && version.length <= 160;
}

function requestOrganizationRefetch(): void {
  window.dispatchEvent(new Event(organizationRefetchEvent));
}

export function useOrganizationRealtime(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const socket = io({
      autoConnect: false,
      path: "/socket.io",
      transports: ["websocket", "polling"],
      withCredentials: true,
    });

    function handleConnect() {
      requestOrganizationRefetch();
    }

    function handleInvalidation(payload: unknown) {
      if (isOrganizationInvalidation(payload)) requestOrganizationRefetch();
    }

    function handleAccessRevoked() {
      window.location.assign("/app/organizations");
    }

    socket.on("connect", handleConnect);
    socket.on("organization:invalidate", handleInvalidation);
    socket.on("organization:access-revoked", handleAccessRevoked);
    socket.connect();

    return () => {
      socket.off("connect", handleConnect);
      socket.off("organization:invalidate", handleInvalidation);
      socket.off("organization:access-revoked", handleAccessRevoked);
      socket.disconnect();
    };
  }, [enabled]);
}
