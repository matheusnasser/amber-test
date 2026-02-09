/**
 * Authentication routes
 */

import express from "express";
import { generateToken, validateCredentials } from "../lib/auth";

export const authRouter = express.Router();

// POST /api/auth/login
authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const isValid = await validateCredentials(email, password);
  if (!isValid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = generateToken(email);

  res.json({
    token,
    expiresIn: "1d",
  });
});
