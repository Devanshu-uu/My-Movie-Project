"use client";

import { Turnstile } from "@marsidev/react-turnstile";
import { env } from "@/utils/env";

type CaptchaFieldProps = {
  onToken: (token: string | null) => void;
};

const CaptchaField: React.FC<CaptchaFieldProps> = ({ onToken }) => {
  const siteKey = env.NEXT_PUBLIC_CAPTCHA_SITE_KEY;

  if (!siteKey || siteKey === "dummy-captcha-key") return null;

  return (
    <div className="flex justify-center py-1">
      <Turnstile
        siteKey={siteKey}
        options={{ theme: "auto" }}
        onSuccess={(token) => onToken(token)}
        onExpire={() => onToken(null)}
        onError={() => onToken(null)}
      />
    </div>
  );
};

export default CaptchaField;
