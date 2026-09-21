import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { KycDocumentKind, KycStatus } from '@prisma/client';
import { ErrorCode } from '@caseforge/shared';
import { PrismaService } from '../common/prisma.service';
import { SettingsService } from '../common/settings.service';
import { badRequest, forbidden, notFound } from '../common/app-error';
import { loadConfig } from '../common/config';

/**
 * Largest document accepted, in bytes.
 *
 * A photograph of a passport page is well under this. The cap exists because
 * the body arrives as base64 in JSON, and an endpoint that will accept any
 * amount of it is a way to fill a disk.
 */
const MAX_DOCUMENT_BYTES = 6 * 1024 * 1024;

/** What a document may be. Anything else is refused before it is written. */
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

export interface SubmitKycInput {
  fullName: string;
  dateOfBirth: string;
  country: string;
  documentNo: string;
  documents: Array<{ kind: KycDocumentKind; contentType: string; base64: string }>;
}

/**
 * Identity checks, reviewed by a person.
 *
 * No third-party verification service. That is a deliberate limit rather than
 * an oversight: a provider integration is a contract, a data-processing
 * agreement and a per-check fee, none of which a codebase can decide on its
 * own. What is here is the part that does not depend on that choice — a record,
 * a queue, a decision, and a gate on withdrawals — and a provider can later be
 * dropped in where the operator currently stands.
 *
 * The data is handled as data nobody wants to hold. Documents never enter
 * Postgres; the application keeps only the fields an operator needs to say yes
 * or no. What is *not* implemented is stated rather than implied: there is no
 * encryption at rest here and no retention schedule, and a deployment that
 * turns this on owes both.
 */
@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);
  private readonly config = loadConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Whether identity checks are switched on at all. */
  async isEnabled(): Promise<boolean> {
    await this.settings.ensureFresh();
    return this.settings.get<boolean>('kyc.enabled') === true;
  }

  /** A player's own standing, including what they submitted. */
  async mine(userId: string) {
    const application = await this.prisma.kycApplication.findUnique({
      where: { userId },
      include: { documents: { select: { id: true, kind: true, byteSize: true } } },
    });

    return {
      enabled: await this.isEnabled(),
      threshold: this.settings.get<number>('kyc.withdrawalThreshold'),
      status: (application?.status ?? 'NONE') as KycStatus,
      reviewNote: application?.reviewNote ?? null,
      submittedAt: application?.submittedAt?.toISOString() ?? null,
      reviewedAt: application?.reviewedAt?.toISOString() ?? null,
      documents: application?.documents ?? [],
    };
  }

  /**
   * Submits, or re-submits after a rejection.
   *
   * An approved application cannot be overwritten. Letting a verified player
   * quietly replace the identity behind their account would make the whole
   * check decorative.
   */
  async submit(userId: string, input: SubmitKycInput) {
    if (!(await this.isEnabled())) {
      throw forbidden(ErrorCode.KYC_DISABLED, 'Identity checks are not in use here');
    }

    const existing = await this.prisma.kycApplication.findUnique({ where: { userId } });
    if (existing?.status === 'APPROVED') {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Your identity is already verified');
    }
    if (existing?.status === 'PENDING') {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Your application is already being reviewed');
    }
    if (input.documents.length === 0) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'At least one document is required');
    }

    const born = new Date(input.dateOfBirth);
    if (Number.isNaN(born.getTime())) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Date of birth is not a date');
    }
    if (this.ageOn(born) < 18) {
      throw badRequest(ErrorCode.KYC_UNDERAGE, 'This site is for adults only');
    }

    // Decoded and checked before anything is written, so a rejected document
    // does not leave a half-finished application with files beside it.
    const decoded = input.documents.map((doc) => this.decode(doc));

    // Replaced wholesale on a re-submission: the previous rejection is in the
    // audit log, and keeping its documents would mean holding identity papers
    // the player has already superseded. The files go with the rows — deleting
    // only the rows would leave the scans on disk with nothing pointing at
    // them, which is the same data with none of the means to find it again.
    const superseded = existing
      ? await this.prisma.kycDocument.findMany({
          where: { applicationId: existing.id },
          select: { storagePath: true },
        })
      : [];

    const application = await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.kycDocument.deleteMany({ where: { applicationId: existing.id } });
      }

      return tx.kycApplication.upsert({
        where: { userId },
        create: {
          userId,
          status: 'PENDING',
          fullName: input.fullName,
          dateOfBirth: born,
          country: input.country.toUpperCase(),
          documentNo: input.documentNo,
        },
        update: {
          status: 'PENDING',
          fullName: input.fullName,
          dateOfBirth: born,
          country: input.country.toUpperCase(),
          documentNo: input.documentNo,
          reviewedById: null,
          reviewNote: null,
          reviewedAt: null,
          submittedAt: new Date(),
        },
      });
    });

    // After the commit, so a transaction that rolled back has not taken the
    // files of an application that still exists with it.
    for (const { storagePath } of superseded) {
      await this.erase(storagePath);
    }

    for (const doc of decoded) {
      const storagePath = path.posix.join(application.id, `${randomUUID()}${doc.extension}`);
      await this.write(storagePath, doc.bytes);
      await this.prisma.kycDocument.create({
        data: {
          applicationId: application.id,
          kind: doc.kind,
          storagePath,
          contentType: doc.contentType,
          byteSize: doc.bytes.byteLength,
        },
      });
    }

    this.logger.log(`KYC ${application.id} submitted with ${decoded.length} document(s)`);
    return this.mine(userId);
  }

  /**
   * Whether this player may take money out.
   *
   * The threshold counts what they have already withdrawn over their lifetime
   * rather than the size of the request in front of them: splitting one large
   * withdrawal into ten small ones is the obvious way around a per-request
   * limit, and a cumulative one does not care.
   */
  async mayWithdraw(userId: string, amount: number): Promise<{ allowed: boolean; reason?: string }> {
    if (!(await this.isEnabled())) return { allowed: true };

    const threshold = this.settings.get<number>('kyc.withdrawalThreshold');

    const application = await this.prisma.kycApplication.findUnique({
      where: { userId },
      select: { status: true },
    });
    if (application?.status === 'APPROVED') return { allowed: true };

    const previous = await this.prisma.withdrawal.aggregate({
      where: { userId, status: { in: ['COMPLETED', 'PARTIAL', 'SENT', 'PROCESSING', 'PENDING'] } },
      _sum: { totalValue: true },
    });
    const lifetime = (previous._sum.totalValue ?? 0) + amount;

    if (lifetime <= threshold) return { allowed: true };

    return {
      allowed: false,
      reason:
        application?.status === 'PENDING'
          ? 'Your identity check is still being reviewed'
          : `Withdrawals past ${(threshold / 100).toFixed(2)} need a verified identity`,
    };
  }

  // --- operator side --------------------------------------------------------

  /** The review queue, oldest first: a queue nobody works from is a backlog. */
  async list(status: KycStatus | undefined, page: number, perPage: number) {
    const where = status ? { status } : {};
    const [total, items] = await Promise.all([
      this.prisma.kycApplication.count({ where }),
      this.prisma.kycApplication.findMany({
        where,
        orderBy: { submittedAt: 'asc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: {
          user: { select: { id: true, username: true, steamId64: true } },
          documents: { select: { id: true, kind: true, contentType: true, byteSize: true } },
        },
      }),
    ]);
    return { total, page, perPage, items };
  }

  /**
   * An operator's decision.
   *
   * A rejection carries a note, and the note reaches the player. "Rejected"
   * with no reason is an invitation to submit exactly the same thing again.
   */
  async decide(
    reviewerId: string,
    applicationId: string,
    approve: boolean,
    note: string | null,
  ) {
    if (!approve && !note?.trim()) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'A rejection needs a reason');
    }

    const application = await this.prisma.kycApplication.findUnique({
      where: { id: applicationId },
    });
    if (!application) throw notFound(ErrorCode.VALIDATION_FAILED, 'No such application');

    return this.prisma.kycApplication.update({
      where: { id: applicationId },
      data: {
        status: approve ? 'APPROVED' : 'REJECTED',
        reviewedById: reviewerId,
        reviewNote: note?.trim() || null,
        reviewedAt: new Date(),
      },
    });
  }

  /**
   * Reads one document back for an operator.
   *
   * The path comes from the database, never from the request: the caller names
   * a document by id, and what is on disk is resolved from the row. A handler
   * that took a path from a query string is a directory traversal waiting to
   * be found.
   */
  async readDocument(documentId: string): Promise<{ bytes: Buffer; contentType: string }> {
    const document = await this.prisma.kycDocument.findUnique({ where: { id: documentId } });
    if (!document) throw notFound(ErrorCode.VALIDATION_FAILED, 'No such document');

    // Belt and braces: the stored path is generated, but a resolve that escapes
    // the root is worth refusing rather than trusting an invariant elsewhere.
    const full = this.within(document.storagePath);
    if (full === null) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Bad document path');

    return { bytes: await readFile(full), contentType: document.contentType };
  }

  // --- internals ------------------------------------------------------------

  private root(): string {
    return path.resolve(process.cwd(), this.config.KYC_STORAGE_DIR);
  }

  /**
   * The absolute path of a stored document, or null if it is not under the root.
   *
   * `startsWith` on the root alone is not the check it looks like: a root of
   * `/var/kyc` is also a prefix of `/var/kyc-backup`, so a relative path would
   * only have to climb one level and come back down under a sibling name.
   * `path.relative` answers the question that was actually being asked — how
   * to get from the root to the file — and a path that leaves the root says so
   * by starting with `..`.
   */
  private within(storagePath: string): string | null {
    const root = this.root();
    const full = path.resolve(root, storagePath);
    const relative = path.relative(root, full);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return full;
  }

  private async write(storagePath: string, bytes: Buffer): Promise<void> {
    const full = this.within(storagePath);
    if (full === null) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Bad document path');
    await mkdir(path.dirname(full), { recursive: true });
    // 0600: readable by the process that wrote it and nothing else on the box.
    await writeFile(full, bytes, { mode: 0o600 });
  }

  /**
   * Removes a stored document.
   *
   * A file that has already gone is the outcome being asked for, so a failure
   * to delete is logged and not thrown: an application the player has just
   * re-submitted must not be refused because of a leftover from the last one.
   */
  private async erase(storagePath: string): Promise<void> {
    const full = this.within(storagePath);
    if (full === null) return;
    try {
      await rm(full, { force: true });
    } catch (err) {
      this.logger.error(`Could not delete superseded document ${storagePath}: ${String(err)}`);
    }
  }

  private decode(doc: { kind: KycDocumentKind; contentType: string; base64: string }): {
    kind: KycDocumentKind;
    contentType: string;
    bytes: Buffer;
    extension: string;
  } {
    if (!ALLOWED_TYPES.has(doc.contentType)) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, `Unsupported document type ${doc.contentType}`);
    }

    // The data-URL prefix is stripped if the browser sent one; base64 with a
    // `data:` header decodes to rubbish rather than failing loudly.
    const payload = doc.base64.includes(',') ? doc.base64.slice(doc.base64.indexOf(',') + 1) : doc.base64;
    const bytes = Buffer.from(payload, 'base64');

    if (bytes.byteLength === 0) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'A document decoded to nothing');
    }
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        `A document may be at most ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`,
      );
    }

    const extension =
      doc.contentType === 'application/pdf'
        ? '.pdf'
        : doc.contentType === 'image/png'
          ? '.png'
          : doc.contentType === 'image/webp'
            ? '.webp'
            : '.jpg';

    return { kind: doc.kind, contentType: doc.contentType, bytes, extension };
  }

  /** Whole years old today. */
  private ageOn(born: Date): number {
    const now = new Date();
    let age = now.getUTCFullYear() - born.getUTCFullYear();
    const month = now.getUTCMonth() - born.getUTCMonth();
    if (month < 0 || (month === 0 && now.getUTCDate() < born.getUTCDate())) age -= 1;
    return age;
  }
}
