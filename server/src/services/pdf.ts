import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { config } from "../config.js";

export interface CertificateData {
  number: string; candidateName: string; courseName: string; centreName: string; score: number; issuedOn: Date;
}

/** Renders an A4 landscape certificate with a QR code that opens the public verification page. */
export async function renderCertificatePdf(d: CertificateData): Promise<Buffer> {
  const verifyUrl = `${config.PUBLIC_WEB_URL}/verify/${d.number}`;
  const qr = await QRCode.toBuffer(verifyUrl, { margin: 1, width: 220 });
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 50, info: { Title: `Certificate ${d.number}`, Author: "Pragati Skills Mission" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const W = doc.page.width, H = doc.page.height;
  doc.rect(25, 25, W - 50, H - 50).lineWidth(3).stroke("#1e3a8a");
  doc.rect(33, 33, W - 66, H - 66).lineWidth(1).stroke("#93c5fd");
  doc.fillColor("#1e3a8a").font("Helvetica-Bold").fontSize(15).text("PRAGATI SKILLS MISSION", 0, 70, { align: "center", characterSpacing: 3 });
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(34).text("Certificate of Completion", 0, 105, { align: "center" });
  doc.font("Helvetica").fontSize(14).fillColor("#374151").text("This is to certify that", 0, 170, { align: "center" });
  doc.font("Helvetica-Bold").fontSize(30).fillColor("#111827").text(d.candidateName, 0, 195, { align: "center" });
  doc.font("Helvetica").fontSize(14).fillColor("#374151")
    .text("has successfully completed and passed the skilling programme", 0, 245, { align: "center" });
  doc.font("Helvetica-Bold").fontSize(22).fillColor("#1e3a8a").text(d.courseName, 0, 272, { align: "center" });
  doc.font("Helvetica").fontSize(12).fillColor("#374151")
    .text(`Trained at ${d.centreName}  |  Score: ${d.score}/100`, 0, 312, { align: "center" });

  doc.image(qr, 70, H - 190, { width: 110 });
  doc.font("Helvetica").fontSize(9).fillColor("#6b7280").text("Scan to verify", 70, H - 78, { width: 110, align: "center" });
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827").text(`Certificate No: ${d.number}`, 220, H - 150);
  doc.font("Helvetica").fontSize(11).fillColor("#374151").text(`Issued on: ${d.issuedOn.toISOString().slice(0, 10)}`, 220, H - 128);
  doc.fontSize(9).fillColor("#6b7280").text(`Verify at ${verifyUrl}`, 220, H - 108);
  doc.end();
  return done;
}
