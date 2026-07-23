import express from "express";
import request from "supertest";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../server.js";
import { validateRequest } from "../validation.js";

function buildApp() {
  const app = express();
  app.use(express.json());

  app.post(
    "/citizens/:id/documents",
    validateRequest({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({
        documentType: z.enum(["national_id", "drivers_license"]),
        issuedAt: z.string().datetime().optional(),
      }),
      query: z.object({ dryRun: z.coerce.boolean().optional().default(false) }),
    }),
    (req, res) => {
      res.status(200).json({ validated: req.validated });
    },
  );

  app.use(errorHandler());
  return app;
}

describe("validateRequest", () => {
  const validId = "11111111-1111-1111-1111-111111111111";

  it("passes through valid requests and rewrites req.validated with parsed/coerced values", async () => {
    const res = await request(buildApp())
      .post(`/citizens/${validId}/documents?dryRun=true`)
      .send({ documentType: "national_id" });

    expect(res.status).toBe(200);
    expect(res.body.validated.params.id).toBe(validId);
    expect(res.body.validated.query.dryRun).toBe(true); // coerced from string "true" to boolean
  });

  it("collects issues from multiple fields (body AND params) in a single error response", async () => {
    const res = await request(buildApp())
      .post("/citizens/not-a-uuid/documents")
      .send({ documentType: "passport" }); // not in the enum

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const paths = res.body.error.details.issues.map((d: { path: string }) => d.path);
    expect(paths).toContain("params.id");
    expect(paths.some((p: string) => p.startsWith("body.documentType"))).toBe(true);
  });

  it("rejects a missing required body field with a field-scoped message", async () => {
    const res = await request(buildApp()).post(`/citizens/${validId}/documents`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues[0].path).toContain("body.documentType");
  });
});
