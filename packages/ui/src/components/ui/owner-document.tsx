import { createContext, useContext, type ReactNode } from "react";

const OwnerDocumentContext = createContext<Document | undefined>(undefined);

export function OwnerDocumentProvider({
  document,
  children,
}: {
  document: Document;
  children: ReactNode;
}) {
  return <OwnerDocumentContext.Provider value={document}>{children}</OwnerDocumentContext.Provider>;
}

export function useOwnerDocument() {
  return useContext(OwnerDocumentContext);
}
