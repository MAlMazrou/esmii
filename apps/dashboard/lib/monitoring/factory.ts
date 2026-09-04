import { parseMonitoringServerConfig } from "../config/server.ts";
import { DashboardMonitoringRepository } from "./repository.ts";

let repository: DashboardMonitoringRepository | undefined;

export function getMonitoringRepository(): DashboardMonitoringRepository {
  repository ??= new DashboardMonitoringRepository(parseMonitoringServerConfig());
  return repository;
}

export function resetMonitoringRepositoryForTests(): void {
  repository = undefined;
}
