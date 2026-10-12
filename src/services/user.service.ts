import bcrypt from "bcryptjs";
import prisma from "../lib/prisma.js";
import { revokeAllRefreshTokens } from "./token.service.js";
import { isLocked, recordFailure, clearFailures } from "./lockout.service.js";

export interface UserUpdateData {
  firstname?: string;
  lastname?: string;
}

// Drivers use a 4-digit PIN (shared with the terminal) and agents live in their own table,
// so neither can use the email/password flows.
const PASSWORD_ROLES = ["STUDENT", "ADMIN"];

const getUserCount = () => prisma.user.count();

const getAllUsers = () =>
  prisma.user.findMany({
    select: {
      id: true,
      firstname: true,
      lastname: true,
      email: true,
      matricNumber: true,
      role: true,
      isVerified: true,
      createdAt: true,
    },
  });

const getUserProfile = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      firstname: true,
      lastname: true,
      email: true,
      matricNumber: true,
      wallet: { select: { balance: true, is_linked: true } },
    },
  });
  if (!user) throw new Error("USER_NOT_FOUND");

  return {
    id: user.id,
    firstName: user.firstname,
    lastName: user.lastname,
    fullname: `${user.firstname} ${user.lastname}`,
    email: user.email,
    matricNumber: user.matricNumber,
    wallet: user.wallet ? { balance: user.wallet.balance, isLinked: user.wallet.is_linked } : null,
  };
};

const updateUserProfile = async (userId: string, { firstname, lastname }: UserUpdateData) => {
  await prisma.user.update({
    where: { id: userId },
    data: { firstname: firstname?.trim() || undefined, lastname: lastname?.trim() || undefined },
  });
  return getUserProfile(userId);
};

// Throws: USER_NOT_FOUND, ROLE_NOT_ALLOWED, TOO_MANY_ATTEMPTS, CURRENT_PASSWORD_INCORRECT, PASSWORD_UNCHANGED.
const changeUserPassword = async (userId: string, currentPassword: string, newPassword: string) => {
  const lockKey = `chpw:${userId}`;
  if (await isLocked(lockKey)) throw new Error("TOO_MANY_ATTEMPTS");

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { password: true, role: true },
  });
  if (!user) throw new Error("USER_NOT_FOUND");
  if (!PASSWORD_ROLES.includes(user.role)) throw new Error("ROLE_NOT_ALLOWED");

  if (!(await bcrypt.compare(currentPassword, user.password))) {
    recordFailure(lockKey);
    throw new Error("CURRENT_PASSWORD_INCORRECT");
  }
  clearFailures(lockKey);
  if (currentPassword === newPassword) throw new Error("PASSWORD_UNCHANGED");

  await prisma.user.update({
    where: { id: userId },
    data: { password: await bcrypt.hash(newPassword, 10) },
  });
  await revokeAllRefreshTokens(userId);
};

// True if this email belongs to an account that may reset its password by email OTP.
const requestPasswordReset = async (email: string): Promise<boolean> => {
  const user = await prisma.user.findUnique({ where: { email }, select: { role: true } });
  return !!user && PASSWORD_ROLES.includes(user.role);
};

// Returns false if the account doesn't exist or isn't eligible.
const resetPasswordWithOTP = async (email: string, newPassword: string): Promise<boolean> => {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } });
  if (!user || !PASSWORD_ROLES.includes(user.role)) return false;

  await prisma.user.update({
    where: { id: user.id },
    data: { password: await bcrypt.hash(newPassword, 10) },
  });
  await revokeAllRefreshTokens(user.id);
  return true;
};

interface StudentFilter {
  page: number;
  limit: number;
  isVerified?: boolean;
}

// Paginated student list for the agent dashboard, with wallet and KYC status.
const getStudentsForAgent = async ({ page, limit, isVerified }: StudentFilter) => {
  const where = {
    role: "STUDENT" as const,
    ...(isVerified !== undefined && { isVerified }),
  };

  const [students, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        email: true,
        matricNumber: true,
        isVerified: true,
        createdAt: true,
        wallet: { select: { balance: true, is_linked: true } },
        kyc: { select: { status: true, submittedAt: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return { students, total, page, totalPages: Math.ceil(total / limit) };
};

interface TransactionFilter {
  page: number;
  limit: number;
}

// Agents can only look up STUDENT accounts, never drivers or admins by guessing a matric.
const getStudentTransactions = async (matricNumber: string, { page, limit }: TransactionFilter) => {
  const matric = matricNumber.toUpperCase();

  const student = await prisma.user.findUnique({
    where: { matricNumber: matric },
    select: { id: true, firstname: true, lastname: true, matricNumber: true, role: true },
  });
  if (!student || student.role !== "STUDENT") throw new Error("STUDENT_NOT_FOUND");

  const [transactions, total] = await prisma.$transaction([
    prisma.transaction.findMany({
      where: { student_uid: matric },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { synced_at: "desc" },
      select: {
        transaction_id: true,
        type: true,
        amount: true,
        terminal_id: true,
        driver_uid: true,
        synced_at: true,
      },
    }),
    prisma.transaction.count({ where: { student_uid: matric } }),
  ]);

  return {
    student: {
      id: student.id,
      firstname: student.firstname,
      lastname: student.lastname,
      matricNumber: student.matricNumber,
    },
    transactions,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
};

export {
  getUserCount,
  getAllUsers,
  getUserProfile,
  updateUserProfile,
  changeUserPassword,
  requestPasswordReset,
  resetPasswordWithOTP,
  getStudentsForAgent,
  getStudentTransactions,
};