import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  const resend = new Resend(process.env.RESEND_API_KEY);

  // API Route: Send Whitelist Email
  app.post("/api/send-whitelist-email", async (req, res) => {
    const { email, addedBy } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    if (!process.env.RESEND_API_KEY) {
      console.error("CRITICAL: RESEND_API_KEY is not set in environment variables.");
      return res.status(500).json({ 
        error: "Configuration Error", 
        details: "RESEND_API_KEY is missing. Please add it to the Secrets panel in AI Studio." 
      });
    }

    console.log(`Attempting to send whitelist email to: ${email}`);

    try {
      const { data, error } = await resend.emails.send({
        from: "Python Tutor <onboarding@resend.dev>",
        to: email,
        subject: "Welcome to the Python Student Support Platform!",
        html: `
          <div style="font-family: sans-serif; padding: 20px; background-color: #0a0a0a; color: #ffffff; border-radius: 12px;">
            <h1 style="color: #f97316; text-transform: uppercase; font-style: italic;">Access Granted!</h1>
            <p>Hello,</p>
            <p>You have been authorized to access the <strong>Python Student Support Platform</strong>.</p>
            <p>You can now log in using your Google account: <strong>${email}</strong></p>
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #27272a;">
              <p style="font-size: 12px; color: #71717a;">This is an automated notification. If you did not expect this, please ignore this email.</p>
            </div>
          </div>
        `,
      });

      if (error) {
        console.error("Resend API Error:", JSON.stringify(error, null, 2));
        
        // Handle specific Resend errors
        if (error.name === 'validation_error' || (error as any).message?.includes('onboarding')) {
          return res.status(403).json({ 
            error: "Resend Restriction", 
            details: "Resend's free tier (onboarding@resend.dev) only allows sending to your own email address. To send to others, you must verify a domain in Resend." 
          });
        }
        
        return res.status(500).json({ error: "Resend failed to send email", details: error.message });
      }

      console.log("Email sent successfully:", data?.id);
      res.json({ success: true, data });
    } catch (err) {
      console.error("Server error sending email:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
