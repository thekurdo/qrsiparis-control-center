/**
 * GET /api/internal/tenants/:id/qr-codes.pdf  (Phase H — operator QoL)
 *
 * Builds a print-ready A4 PDF of the 10 table QR codes for a tenant. The
 * operator clicks "QR Kodlarını İndir" on the tenant detail page; the
 * browser downloads the PDF directly via the `download` attribute on the
 * `<a>` tag (no fetch/blob dance).
 *
 * Why this lives in the control-center (and not customer-app):
 *   The control-center is the operator's source of truth. Generating the
 *   sheet here avoids a cross-app auth handshake and keeps the
 *   "give me a fresh QR pack for table 7" workflow inside the panel the
 *   operator already has open. The customer-app's own /admin can keep its
 *   in-app QR view; this endpoint is the bulk-export sibling.
 *
 * Why deterministic tokens, not a tenant-DB query:
 *   Per the auto-seed contract (PB-AUTOS-001 / app v0.1.x bootstrap), every
 *   tenant container gets exactly 10 tables seeded with deterministic
 *   tokens `qr-demo-01..qr-demo-10`. The control-center DOES NOT have a
 *   per-tenant DB connection (V1 boundary — only SSH-shell access via the
 *   deploy worker), so we can't run a SELECT on the tenant's tables row.
 *   The deterministic-token guarantee is exactly the escape hatch we lean
 *   on here. If/when V1.5 introduces remote read of the tenant DB, we can
 *   swap to a live query without changing the URL shape.
 *
 * Auth: admin OR operator. Read-only export; doesn't mutate state.
 *
 * Failure modes:
 *   - 404 NOT_FOUND        — tenant id doesn't exist
 *   - 422 BUSINESS_RULE_VIOLATION — tenant.status === 'cancelled'
 *     (we still allow paused tenants — operators may need to reprint a
 *     sheet while a tenant is temporarily down for maintenance)
 *
 * Library choice: `qrcode` (PNG buffer) + `pdfkit` (Node-native PDF
 * builder). Both work in the Next.js Node runtime; we explicitly pin
 * `runtime = 'nodejs'` to defend against accidental edge-runtime
 * promotion (pdfkit reads its built-in Helvetica .afm via `fs`).
 * `pdfkit` is also added to `serverExternalPackages` in next.config.ts so
 * Turbopack doesn't try to bundle the .afm fonts.
 */

import { eq } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

import { db } from '@/db/client';
import { tenants } from '@/db/schema';
import { errorResponse } from '@/lib/api/response';
import { requireOperatorAuth } from '@/lib/auth/middleware';

// Pin to Node runtime — pdfkit + qrcode both pull `fs` / `Buffer` paths.
export const runtime = 'nodejs';
// Never cache: the underlying tenant config (restaurant name, domain) may
// change between requests and a stale CDN copy would print the wrong
// header on the printed sheets.
export const dynamic = 'force-dynamic';

/** A4 page size in PDF points (1 pt = 1/72"). 210×297 mm. */
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
/** Target QR image size on the page (~12 cm square). 1 cm = 28.346 pt. */
const QR_SIDE_PT = 340; // ≈ 12 cm

/**
 * Generate a single PNG buffer for a given URL. We pick `errorCorrectionLevel: 'M'`
 * — middle ground between density and fault tolerance for laminated table
 * cards (smudges + cup-rings are real failure modes for restaurant QRs).
 * Margin 1 is the smallest "quiet zone" the QR spec accepts; we add our
 * own visual padding by placing the image inside a centred frame on the
 * PDF page, so the in-image margin is just there to satisfy decoders.
 */
async function renderQrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 800, // PNG pixel size; downscaled by pdfkit to fit QR_SIDE_PT
    color: { dark: '#000000', light: '#ffffff' },
  });
}

/**
 * Assemble the PDF. Resolves to the complete PDF byte buffer (we don't
 * stream because Next.js Route handlers want a finite Response body and
 * the file is small — 10 QR PNGs are well under 1 MB total).
 */
async function buildPdf(args: {
  restaurantName: string;
  domain: string;
  tokens: string[];
}): Promise<Buffer> {
  const { restaurantName, domain, tokens } = args;

  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      // Disable autoFirstPage — we add pages in the loop below so the
      // first table doesn't share a page with an empty header.
      autoFirstPage: false,
      info: {
        Title: `QR Kodlari - ${restaurantName}`,
        Author: 'QrSiparis Control Center',
        Subject: `Tenant ${domain} table QR sheet`,
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Render all 10 QR PNGs sequentially. We could parallelise with
    // Promise.all, but a) the PDF page-order needs to be deterministic
    // and b) the marginal speedup on 10 tiny QRs is negligible.
    // The async work happens outside the new-Promise executor to keep
    // the rejection path clean — note we cannot `await` directly here,
    // so we IIFE.
    (async () => {
      try {
        for (let i = 0; i < tokens.length; i += 1) {
          const tableNo = i + 1;
          const token = tokens[i]!;
          const url = `https://${domain}/tr?t=${token}`;
          const png = await renderQrPng(url);

          doc.addPage();

          // Header: restaurant name, centred.
          doc
            .fillColor('#0f172a')
            .font('Helvetica-Bold')
            .fontSize(22)
            .text(restaurantName, 40, 60, {
              width: A4_WIDTH_PT - 80,
              align: 'center',
            });

          // Subheading: domain (smaller, muted).
          doc
            .fillColor('#475569')
            .font('Helvetica')
            .fontSize(12)
            .text(domain, 40, 92, {
              width: A4_WIDTH_PT - 80,
              align: 'center',
            });

          // QR image — centred horizontally, ~3 cm below the header.
          const qrX = (A4_WIDTH_PT - QR_SIDE_PT) / 2;
          const qrY = 170;
          doc.image(png, qrX, qrY, { width: QR_SIDE_PT, height: QR_SIDE_PT });

          // "Masa No: N" — big bold text below the QR.
          doc
            .fillColor('#0f172a')
            .font('Helvetica-Bold')
            .fontSize(36)
            .text(`Masa No: ${tableNo}`, 40, qrY + QR_SIDE_PT + 24, {
              width: A4_WIDTH_PT - 80,
              align: 'center',
            });

          // Footer: instructions + page number, near the bottom.
          doc
            .fillColor('#64748b')
            .font('Helvetica')
            .fontSize(11)
            .text(
              'Telefonunuzun kamerasıyla QR kodu okutun',
              40,
              A4_HEIGHT_PT - 70,
              {
                width: A4_WIDTH_PT - 80,
                align: 'center',
              },
            );
          doc
            .fillColor('#94a3b8')
            .fontSize(9)
            .text(
              `${domain}  ·  Sayfa ${tableNo} / ${tokens.length}`,
              40,
              A4_HEIGHT_PT - 50,
              {
                width: A4_WIDTH_PT - 80,
                align: 'center',
              },
            );
        }
        doc.end();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireOperatorAuth(['admin', 'operator']);
  const { id } = await params;

  const [tenant] = await db
    .select({
      id: tenants.id,
      restaurantName: tenants.restaurantName,
      domain: tenants.domain,
      shortCode: tenants.shortCode,
      status: tenants.status,
    })
    .from(tenants)
    .where(eq(tenants.id, id))
    .limit(1);

  if (!tenant) {
    return errorResponse('NOT_FOUND', 'Müşteri bulunamadı');
  }

  if (tenant.status === 'cancelled') {
    return errorResponse(
      'BUSINESS_RULE_VIOLATION',
      'İptal edilmiş müşteri için QR kodları oluşturulamaz',
      { details: { errorCode: 'TENANT_CANCELLED', status: tenant.status } },
    );
  }

  // Deterministic auto-seed tokens: qr-demo-01..qr-demo-10. Zero-padded so
  // the printed URLs (and any future log-line scan) sort lexically.
  const tokens = Array.from({ length: 10 }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return `qr-demo-${n}`;
  });

  let pdf: Buffer;
  try {
    pdf = await buildPdf({
      restaurantName: tenant.restaurantName,
      domain: tenant.domain,
      tokens,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[tenants/qr-codes.pdf][GET] build failed', err);
    return errorResponse('INTERNAL_ERROR', 'PDF oluşturulamadı');
  }

  // ASCII-safe filename for the Content-Disposition header — shortCode is
  // already constrained to `^[a-z0-9-]+$` by the tenants check constraint,
  // so no sanitisation needed.
  const filename = `qr-${tenant.shortCode}.pdf`;

  // Convert Node Buffer to Uint8Array view (zero-copy via subarray) so
  // NextResponse's BodyInit-compatible types are happy on all runtimes.
  const body = new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength);

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(pdf.byteLength),
      'Cache-Control': 'private, no-store',
    },
  });
}
