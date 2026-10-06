import prisma from "../lib/prisma.js";
import bcrypt from "bcryptjs";

export interface UserUpdateData {
  firstname?: string;
  lastname?: string;
}

const getUserCount = async () => {
  const count = await prisma.user.count();
  return count;
};

const getAllUsers = async () => {
  const users = await prisma.user.findMany({
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
  return users;
};

const getUserProfile = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      firstname: true,
      lastname: true,
      email: true,
      matricNumber: true,
      wallet: {
        select: {
          balance: true,
          is_linked: true,
        },
      },
    },
  });

  if (!user) {
    throw new Error("User not found");
  }

  return {
    id: user.id,
    firstName: user.firstname,
    lastName: user.lastname,
    fullname: `${user.firstname} ${user.lastname}`,
    email: user.email,
    matricNumber: user.matricNumber,

    wallet: user.wallet
      ? {
          balance: user.wallet.balance,
          isLinked: user.wallet.is_linked,
        }
      : null,
  };
};

const updateUserProfile = async (userId: string, data: UserUpdateData) => {
  const { firstname, lastname } = data;

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        ...(firstname && { firstname: firstname.trim() }),
        ...(lastname && { lastname: lastname.trim() }),
      },
    });

  });

  return await getUserProfile(userId);
};

const changeUserPassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string
) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { password: true },
  });

  if (!user) {
    throw new Error("User not found");
  }

  const isValid = await bcrypt.compare(currentPassword, user.password);
  if (!isValid) {
    throw new Error("Current password is incorrect");
  }

  if (currentPassword === newPassword) {
    throw new Error("New password cannot be the same as the current password");
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10);

  await prisma.user.update({
    where: { id: userId },
    data: { password: hashedPassword },
  });
};

const requestPasswordReset = async (email: string) => {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, email: true },
  });

  if (!user) {
    throw new Error("No account found with this email");
  }

  return user;
};

const resetPasswordWithOTP = async (email: string, newPassword: string) => {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true },
  });

  if (!user) {
    throw new Error("User not found");
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10);

  await prisma.user.update({
    where: { id: user.id },
    data: { password: hashedPassword },
  });

  return user.id;
};

export {
  getUserProfile,
  updateUserProfile,
  changeUserPassword,
  getUserCount,
  getAllUsers,
  requestPasswordReset,
  resetPasswordWithOTP,
};

// ─────────────────────────────────────────────
// getStudentsForAgent
// Paginated student list for the agent dashboard.
// Includes wallet + KYC status so the agent can
// spot unverified accounts or unlinked wallets
// without extra round-trips.
// ─────────────────────────────────────────────
interface StudentFilter {
  page: number;
  limit: number;
  isVerified?: boolean;
}

const getStudentsForAgent = async (filters: StudentFilter) => {
  const { page, limit, isVerified } = filters;
  const skip = (page - 1) * limit;

  const where = {
    role: "STUDENT" as const,
    // Only apply isVerified filter when explicitly passed —
    // undefined means "return all" regardless of verification status
    ...(isVerified !== undefined && { isVerified }),
  };

  const [students, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      skip,
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
        wallet: {
          select: { balance: true, is_linked: true },
        },
        kyc: {
          select: { status: true, submittedAt: true },
        },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return {
    students,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
};

// ─────────────────────────────────────────────
// getStudentTransactions
// Transaction history for a specific student,
// used by agents to investigate disputes and
// network errors. Confirms the student exists
// and has STUDENT role before querying — agents
// must not be able to pull driver transactions
// by guessing a matricNumber.
// ─────────────────────────────────────────────
interface TransactionFilter {
  page: number;
  limit: number;
}

const getStudentTransactions = async (
  matricNumber: string,
  filters: TransactionFilter
) => {
  const { page, limit } = filters;
  const skip = (page - 1) * limit;
  const normalisedMatric = matricNumber.toUpperCase();

  const student = await prisma.user.findUnique({
    where: { matricNumber: normalisedMatric },
    select: {
      id: true,
      firstname: true,
      lastname: true,
      matricNumber: true,
      role: true,
    },
  });

  if (!student || student.role !== "STUDENT") {
    throw new Error("STUDENT_NOT_FOUND");
  }

  const [transactions, total] = await prisma.$transaction([
    prisma.transaction.findMany({
      where: { student_uid: normalisedMatric },
      skip,
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
    prisma.transaction.count({ where: { student_uid: normalisedMatric } }),
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

export { getStudentsForAgent, getStudentTransactions };
