import speakeasy from "speakeasy";
import nodemailer from "nodemailer";
import env from "../config/env.js";

const generateOTP = (email: string): string => {
  const secret = `${env.otp.secret}_${email}`;
  return speakeasy.totp({
    secret,
    encoding: "ascii",
    step: 600,
    digits: 6,
  });
};

const verifyOTPToken = (email: string, token: string): boolean => {
  const secret = `${env.otp.secret}_${email}`;
  return speakeasy.totp.verify({
    secret,
    encoding: "ascii",
    token,
    step: 600,
    digits: 6,
    window: 1,
  });
};

const createTransporter = () => {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: env.mail.user,
      pass: env.mail.password,
    },
  });
};

const sendOTPEmail = async (email: string, otp: string): Promise<void> => {
  const transporter = createTransporter();
  await transporter.sendMail({
    from: `"CTransit" <${env.mail.user}>`,
    to: email,
    subject: "Verify your CTransit account",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 24px;">
        <h2 style="color: #1a3c8f; margin-bottom: 8px;">
          CTransit Email Verification
        </h2>
        <p style="color: #444;">
          Use the OTP below to verify your email address.
          It expires in <strong>10 minutes</strong>.
        </p>
        <div style="
          font-size: 36px;
          font-weight: bold;
          letter-spacing: 12px;
          color: #1a3c8f;
          background: #f0f4ff;
          padding: 20px;
          text-align: center;
          border-radius: 8px;
          margin: 24px 0;
          border: 1px solid #d0d9f5;
        ">
          ${otp}
        </div>
        <p style="color: #444; font-size: 14px;">
          Enter this code on the verification page to activate your account.
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="color: #aaa; font-size: 12px;">
          If you did not create a CTransit account, you can safely ignore this email.
          This OTP will expire automatically.
        </p>
      </div>
    `,
  });
};

export { generateOTP, verifyOTPToken, sendOTPEmail };
