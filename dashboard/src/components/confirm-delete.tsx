import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/**
 * 消す前に一度止める。**取り消す手段がどこにも無い** — API は delete しか持たず、
 * 画面にも履歴が無いので、押し間違いはそのまま失われる。
 */
export function ConfirmDelete({
  what,
  note,
  onConfirm,
  children,
}: {
  /** 何を消すのか。名前をそのまま入れる（「辞書の語」ではなく「バキュームフル」）。 */
  what: string;
  /** 消すと何が起きるか。巻き添えがあるなら書く。 */
  note?: string;
  onConfirm: () => void;
  children: ReactNode;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>「{what}」を削除しますか？</AlertDialogTitle>
          <AlertDialogDescription>{note ?? "戻せません。"}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>キャンセル</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-dont text-white hover:bg-dont/90 focus-visible:ring-dont/40"
          >
            削除する
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
