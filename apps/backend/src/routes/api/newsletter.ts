import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { resend } from "../../lib/resend";

/** The product newsletter (Resend audience). */
const newsletter = new Hono().post(
  "/newsletter/subscribe",
  zValidator("json", z.object({ email: z.string().email() })),
  async (c) => {
    const { email } = c.req.valid("json");

    if (!process.env.RESEND_API_KEY || !process.env.RESEND_AUDIENCE_ID) {
      return c.json(
        { success: false, error: "Newsletter service is not configured." },
        500,
      );
    }

    try {
      const contact = await resend.contacts.create({
        email,
        unsubscribed: false,
        audienceId: process.env.RESEND_AUDIENCE_ID,
      });
      // Resend returns provider failures as data rather than rejecting.
      if (contact.error) {
        throw Object.assign(new Error(contact.error.message), {
          statusCode: contact.error.statusCode,
        });
      }

      return c.json({
        success: true,
        message:
          "Successfully subscribed! You'll be notified about new features and updates.",
        contactId: contact.data.id,
      });
    } catch (err: unknown) {
      console.error(`Newsletter subscription error for ${email}:`, err);

      const message = err instanceof Error ? err.message : "";
      const statusCode =
        typeof err === "object" && err !== null && "statusCode" in err
          ? err.statusCode
          : null;

      if (message.includes("already exists") || message.includes("duplicate")) {
        return c.json({
          success: true,
          message:
            "You're already subscribed! You'll be notified about new features and updates.",
        });
      }

      if (statusCode === 422) {
        return c.json(
          { success: false, error: "Invalid email address format." },
          400,
        );
      }

      if (statusCode === 401) {
        console.error("Resend API authentication failed - check API key");
        return c.json(
          {
            success: false,
            error: "Newsletter service authentication failed.",
          },
          500,
        );
      }

      return c.json(
        {
          success: false,
          error: "Failed to subscribe. Please try again later.",
        },
        500,
      );
    }
  },
);

export default newsletter;
