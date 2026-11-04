import { describe, it, expect } from 'vitest';
import {
  ArtifactTypeSchema,
  ExperimentVerdictSchema,
  ExperimentExecutionStepSchema,
  ExperimentArtifactPayloadSchema,
  ObservationArtifactPayloadSchema,
} from '../src/core/contracts.js';
import { AuthorityGuard } from '../src/core/workflow.js';
import { HarnessRegistry } from '../src/runtime/harnesses.js';

describe('Governed Agentic Development (ADR-002)', () => {
  describe('ArtifactTypeSchema', () => {
    it('accepts EXPERIMENT and OBSERVATION artifact types', () => {
      expect(ArtifactTypeSchema.safeParse('EXPERIMENT').success).toBe(true);
      expect(ArtifactTypeSchema.safeParse('OBSERVATION').success).toBe(true);
      expect(ArtifactTypeSchema.safeParse('UNKNOWN_TYPE').success).toBe(false);
    });
  });

  describe('ExperimentVerdictSchema', () => {
    it('validates all 4 governance verdicts', () => {
      const validVerdicts = [
        'DISCARD',
        'PROMOTE_TO_ADR',
        'PROMOTE_TO_SPEC',
        'NEEDS_FURTHER_EXPERIMENTATION',
      ];

      for (const verdict of validVerdicts) {
        expect(ExperimentVerdictSchema.safeParse(verdict).success).toBe(true);
      }

      expect(ExperimentVerdictSchema.safeParse('APPROVE_DIRECTLY').success).toBe(false);
    });
  });

  describe('ExperimentArtifactPayloadSchema', () => {
    it('validates a comprehensive experiment payload', () => {
      const validPayload = {
        hypothesis: 'Validate that better-sqlite3 compiles in Linux bwrap namespaces',
        context: {
          environment: 'LINUX_BWRAP',
          branchOrCommit: 'feature/spike-sqlite-bwrap',
          targetDependencies: ['better-sqlite3@11.0.0'],
        },
        steps: [
          {
            stepNumber: 1,
            commandOrSnippet: 'bwrap --ro-bind / / --dev /dev npm rebuild better-sqlite3',
            exitCode: 0,
            observedOutput: 'gyp info ok',
            executionTimeMs: 1420,
          },
        ],
        rawEvidenceSnippet: 'gyp info ok\nBinding compiled successfully.',
        findings: [
          'better-sqlite3 compiles without network access if pre-cached headers exist.',
          'Memory overhead inside namespace is less than 15MB.',
        ],
        openQuestionsForPo: ['Do we require pre-built binaries for ARM64 runners?'],
        verdict: 'PROMOTE_TO_ADR',
        justification: 'Confirms sandboxed SQLite persistence is viable without root privileges.',
        promotedTo: {
          artifactCode: 'ADR-003',
          promotedAt: '2026-11-04T19:30:00.000Z',
        },
      };

      const result = ExperimentArtifactPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.verdict).toBe('PROMOTE_TO_ADR');
        expect(result.data.promotedTo?.artifactCode).toBe('ADR-003');
      }
    });

    it('rejects payload with hypothesis shorter than 10 characters', () => {
      const invalid = {
        hypothesis: 'Spike',
        context: { environment: 'LOCAL_PROCESS' },
        steps: [
          {
            stepNumber: 1,
            commandOrSnippet: 'ls',
            observedOutput: 'ok',
          },
        ],
        findings: ['Worked'],
        verdict: 'DISCARD',
        justification: 'Insufficient test',
      };

      const result = ExperimentArtifactPayloadSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('rejects payload with empty steps', () => {
      const invalid = {
        hypothesis: 'Valid hypothesis with enough length',
        context: { environment: 'LOCAL_PROCESS' },
        steps: [],
        findings: ['Worked'],
        verdict: 'DISCARD',
        justification: 'Valid justification with enough characters',
      };

      const result = ExperimentArtifactPayloadSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('rejects payload with empty findings', () => {
      const invalid = {
        hypothesis: 'Valid hypothesis with enough length',
        context: { environment: 'LOCAL_PROCESS' },
        steps: [
          {
            stepNumber: 1,
            commandOrSnippet: 'echo test',
            observedOutput: 'test',
          },
        ],
        findings: [],
        verdict: 'DISCARD',
        justification: 'Valid justification with enough characters',
      };

      const result = ExperimentArtifactPayloadSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('ObservationArtifactPayloadSchema', () => {
    it('validates a complete observation payload with EXTERNAL_SYSTEM environment', () => {
      const validPayload = {
        targetEntity: 'GitHub GraphQL API Rate Limits',
        environment: 'EXTERNAL_SYSTEM',
        summary: 'Observed 403 secondary rate limit when executing 100 queries/min.',
        findings: [
          'Secondary rate limit returns retry-after header in seconds.',
          'Mutations consume 10x query quota points.',
        ],
        relatedFiles: ['src/runtime/github-client.ts'],
        tracesToArtifacts: ['REQ-002'],
        potentialRisks: ['Batch polling could throttle the daemon process.'],
      };

      const result = ObservationArtifactPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });
  });

  describe('AuthorityGuard artifact write permissions', () => {
    it('allows Architect and Developer to write EXPERIMENT and OBSERVATION', () => {
      expect(AuthorityGuard.canWriteArtifact('architect', 'EXPERIMENT')).toBe(true);
      expect(AuthorityGuard.canWriteArtifact('architect', 'OBSERVATION')).toBe(true);

      expect(AuthorityGuard.canWriteArtifact('developer', 'EXPERIMENT')).toBe(true);
      expect(AuthorityGuard.canWriteArtifact('developer', 'OBSERVATION')).toBe(true);
    });

    it('allows QA to write OBSERVATION but not EXPERIMENT', () => {
      expect(AuthorityGuard.canWriteArtifact('qa', 'OBSERVATION')).toBe(true);
      expect(AuthorityGuard.canWriteArtifact('qa', 'EXPERIMENT')).toBe(false);
    });

    it('allows Product Owner to write EXPERIMENT and OBSERVATION', () => {
      expect(AuthorityGuard.canWriteArtifact('product_owner', 'EXPERIMENT')).toBe(true);
      expect(AuthorityGuard.canWriteArtifact('product_owner', 'OBSERVATION')).toBe(true);
    });
  });

  describe('HarnessRegistry allowed artifact types', () => {
    it('includes EXPERIMENT and OBSERVATION in Architect and Developer harnesses', () => {
      const architectHarness = HarnessRegistry.getHarness('architect');
      expect(architectHarness.allowedArtifactTypes).toContain('EXPERIMENT');
      expect(architectHarness.allowedArtifactTypes).toContain('OBSERVATION');

      const devHarness = HarnessRegistry.getHarness('developer');
      expect(devHarness.allowedArtifactTypes).toContain('EXPERIMENT');
      expect(devHarness.allowedArtifactTypes).toContain('OBSERVATION');

      const qaHarness = HarnessRegistry.getHarness('qa');
      expect(qaHarness.allowedArtifactTypes).toContain('OBSERVATION');
      expect(qaHarness.allowedArtifactTypes).not.toContain('EXPERIMENT');
    });
  });
});
