import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { api } from "../lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import { Alert, AlertDescription } from "@/components/ui/alert";

const schema = z.object({
  email: z.string().email("Please enter a valid email address."),
});

type FormValues = z.infer<typeof schema>;

export default function NewsletterForm() {
  const [serverStatus, setServerStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "" },
  });

  async function onSubmit(data: FormValues) {
    setServerStatus(null);

    try {
      const res = await api.newsletter.subscribe.$post({ json: data });
      const body = await res.json();

      if (body.success) {
        setServerStatus({ type: "success", message: body.message });
        form.reset();
      } else {
        setServerStatus({ type: "error", message: body.error });
      }
    } catch {
      setServerStatus({
        type: "error",
        message: "Network error. Please try again.",
      });
    }
  }

  return (
    <div className="bg-gray-100 rounded-lg p-5 text-center">
      <h3 className="text-base font-semibold text-gray-800 mb-1">
        Stay Updated
      </h3>
      <p className="text-sm text-gray-500 mb-4">
        Get notified about new features and service announcements.
      </p>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <div className="flex gap-2 max-w-md mx-auto">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem className="flex-1 gap-0">
                  <FormControl>
                    <Input
                      {...field}
                      type="email"
                      placeholder="your@email.com"
                    />
                  </FormControl>
                  <FormMessage className="text-left mt-1" />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              disabled={form.formState.isSubmitting}
              className="bg-imdb text-black hover:bg-imdb-dark whitespace-nowrap"
            >
              {form.formState.isSubmitting ? "Subscribing..." : "Subscribe"}
            </Button>
          </div>
          {serverStatus && (
            <Alert
              className={`mt-3 inline-flex max-w-md ${
                serverStatus.type === "success"
                  ? "border-green-200 bg-green-50 text-green-700"
                  : "border-red-200 bg-red-50 text-red-600"
              }`}
            >
              <AlertDescription>{serverStatus.message}</AlertDescription>
            </Alert>
          )}
        </form>
      </Form>
    </div>
  );
}
