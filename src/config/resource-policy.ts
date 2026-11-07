import { z } from "zod";

/** Reviewed canonical pairs only. Configuration can narrow, never extend this surface. */
export const REVIEWED_READ_KINDS = Object.freeze(
  [
    { apiVersion: "v1", kind: "Pod" },
    { apiVersion: "v1", kind: "Service" },
    { apiVersion: "v1", kind: "Endpoints" },
    { apiVersion: "v1", kind: "Node" },
    { apiVersion: "v1", kind: "Namespace" },
    { apiVersion: "v1", kind: "Event" },
    { apiVersion: "v1", kind: "ConfigMap" },
    { apiVersion: "v1", kind: "PersistentVolumeClaim" },
    { apiVersion: "v1", kind: "PersistentVolume" },
    { apiVersion: "apps/v1", kind: "Deployment" },
    { apiVersion: "apps/v1", kind: "ReplicaSet" },
    { apiVersion: "apps/v1", kind: "StatefulSet" },
    { apiVersion: "apps/v1", kind: "DaemonSet" },
    { apiVersion: "batch/v1", kind: "Job" },
    { apiVersion: "batch/v1", kind: "CronJob" },
    { apiVersion: "networking.k8s.io/v1", kind: "Ingress" },
    { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy" },
    { apiVersion: "discovery.k8s.io/v1", kind: "EndpointSlice" },
    { apiVersion: "events.k8s.io/v1", kind: "Event" },
  ].map((pair) => Object.freeze(pair)),
);

export const resourceReadPolicySchema = z.strictObject({
  allowedReadKinds: z
    .array(z.strictObject({ apiVersion: z.string(), kind: z.string() }))
    .refine(
      (pairs) =>
        pairs.every((pair) =>
          REVIEWED_READ_KINDS.some(
            (reviewed) => reviewed.apiVersion === pair.apiVersion && reviewed.kind === pair.kind,
          ),
        ),
      "Expected reviewed canonical resource kinds.",
    )
    .refine(
      (pairs) =>
        new Set(pairs.map((pair) => `${pair.apiVersion}/${pair.kind}`)).size === pairs.length,
      "Duplicate resource kinds.",
    )
    .default([...REVIEWED_READ_KINDS]),
});
/**
 type ResourceReadPolicy = {
 allowedReadKinds: {
 apiVersion: string;
 kind: string;
 }[];
 };
 */
export type ResourceReadPolicy = z.output<typeof resourceReadPolicySchema>;
export const DEFAULT_RESOURCE_READ_POLICY = resourceReadPolicySchema.parse({});
