/**
 * Authentication utilities - Simple demo auth with env credentials
 */

import jwt from "jsonwebtoken";

// Demo credentials from environment variables
const DEMO_EMAIL = process.env.DEMO_EMAIL;
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// JWT secret from environment or default
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = "1d"; // 7 days

export interface TokenPayload {
  email: string;
  iat?: number;
  exp?: number;
}

/**
 * Validate user credentials against environment variables
 */
export async function validateCredentials(
  email: string,
  password: string,
): Promise<boolean> {
  return email === DEMO_EMAIL && password === DEMO_PASSWORD;
}

/**
 * Generate JWT token for authenticated user
 */
export function generateToken(email: string): string {
  const payload: TokenPayload = { email };
  return jwt.sign(payload, JWT_SECRET!, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Verify and decode JWT token
 */
export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET!) as TokenPayload;
    return decoded;
  } catch (error) {
    return null;
  }
}
