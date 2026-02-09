/**
 * JWT Authentication Middleware
 */

import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/auth";

export interface AuthRequest extends Request {
  user?: {
    email: string;
  };
}

/**
 * Middleware to verify JWT token from Authorization header
 */
export function authenticateToken(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

  if (!token) {
    res.status(401).json({ error: "Access token required" });
    return;
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    res.status(403).json({ error: "Invalid or expired token" });
    return;
  }

  req.user = { email: decoded.email };
  next();
}

/**
 * Optional authentication - sets user if token exists, but doesn't block
 */
export function optionalAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (token) {
    const decoded = verifyToken(token);
    if (decoded) {
      req.user = { email: decoded.email };
    }
  }

  next();
}
