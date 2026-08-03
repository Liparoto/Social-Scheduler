import React from "react";

export default function Link({ href, children, ...props }) {
  return React.createElement("a", { href, ...props }, children);
}
