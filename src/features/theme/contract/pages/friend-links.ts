import type { FieldErrors, UseFormRegister } from "react-hook-form";
import type { TurnstileProps } from "@/components/common/turnstile";
import type {
  FriendLinkPublic,
  SubmitFriendLinkInput,
} from "@/features/friend-links/friend-links.schema";

export interface FriendLinksPageProps {
  links: Array<FriendLinkPublic>;
}

export interface MyFriendLink {
  id: number;
  siteName: string;
  siteUrl: string;
  status: "pending" | "approved" | "rejected";
  rejectionReason: string | null;
  createdAt: Date | string;
}

export interface FriendLinkSubmitFormData {
  register: UseFormRegister<SubmitFriendLinkInput>;
  errors: FieldErrors<SubmitFriendLinkInput>;
  handleSubmit: (e?: React.BaseSyntheticEvent) => Promise<void>;
  isSubmitting: boolean;
  turnstileProps: TurnstileProps;
}

export interface SubmitFriendLinkPageProps {
  myLinks: Array<MyFriendLink>;
  form: FriendLinkSubmitFormData;
}
