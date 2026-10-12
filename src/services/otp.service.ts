import speakeasy from "speakeasy";
import nodemailer, { Transporter} from "nodemailer";
import env from "../config/env.js";
import { getRedisClient } from "../config/redis.js";

export type OtpPurpose = "verify" | "reset";

const STEP = 600; // 10 minutes
const WINDOW = 1; // tolerate one step either side (a code can stay valid up to ~30 min)

// "verify" keeps the original derivation so codes already emailed still work.
const secretFor = (email: string, purpose: OtpPurpose) =>
  purpose === "verify" ? `${env.otp.secret}_${email}` : `${env.otp.secret}_${purpose}_${email}`;

const generateOTP = (email: string, purpose: OtpPurpose = "verify"): string =>
  speakeasy.totp({ secret: secretFor(email, purpose), encoding: "ascii", step: STEP, digits: 6 });

const verifyOTPToken = (email: string, token: string, purpose: OtpPurpose = "verify"): boolean =>
  speakeasy.totp.verify({
    secret: secretFor(email, purpose),
    encoding: "ascii",
    token,
    step: STEP,
    digits: 6,
    window: WINDOW,
  });

// Accepts a valid code once. Fails closed (throws) if Redis is down.
const verifyOTPOnce = async (email: string, token: string, purpose: OtpPurpose): Promise<boolean> => {
  if (!verifyOTPToken(email, token, purpose)) return false;
  const first = await getRedisClient().set(`otp_used:${purpose}:${email}:${token}`, "1", "EX", 35 * 60, "NX");
  return first === "OK";
};

let transporter: Transporter | undefined;
const getTransporter = () =>
  (transporter ??= nodemailer.createTransport({
    service: "gmail",
    auth: { user: env.mail.user, pass: env.mail.password },
  }));

const COPY: Record<OtpPurpose, { subject: string; heading: string; body: string; footer: string }> = {
  verify: {
    subject: "Verify your CTransit account",
    heading: "CTransit Email Verification",
    body: "Use the OTP below to verify your email address.",
    footer: "If you did not create a CTransit account, you can safely ignore this email.",
  },
  reset: {
    subject: "Reset your CTransit password",
    heading: "CTransit Password Reset",
    body: "Use the OTP below to reset your password.",
    footer: "If you did not request a password reset, ignore this email. Your password is unchanged.",
  },
};

const sendOTPEmail = async (email: string, otp: string, purpose: OtpPurpose = "verify"): Promise<void> => {
  const c = COPY[purpose];
  await getTransporter().sendMail({
    from: `"CTransit" <${env.mail.user}>`,
    to: email,
    subject: c.subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 24px;">
        <h2 style="color: #1a3c8f; margin-bottom: 8px;">${c.heading}</h2>
        <p style="color: #444;">${c.body} It expires in <strong>10 minutes</strong>.</p>
        <div style="font-size: 36px; font-weight: bold; letter-spacing: 12px; color: #1a3c8f; background: #f0f4ff; padding: 20px; text-align: center; border-radius: 8px; margin: 24px 0; border: 1px solid #d0d9f5;">
          ${otp}
        </div>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="color: #aaa; font-size: 12px;">${c.footer}</p>
      </div>
    `,
  });
};

export { generateOTP, verifyOTPToken, verifyOTPOnce, sendOTPEmail };