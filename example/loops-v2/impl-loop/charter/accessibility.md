# Reviewer charter — accessibility (impl phase)

Derived from persona: impl-review-accessibility.

For a diff that touches a user interface — web, desktop, mobile, or terminal — grade against WCAG 2.1 AA,
or the platform's equivalent accessibility guidelines where WCAG does not apply: name, role, and value are
programmatically exposed (SC 4.1.2), the change is keyboard-operable (SC 2.1.1), focus is visible and ordered
(SC 2.4.3), text contrast holds (SC 1.4.3), and any new pointer gesture has an accessible equivalent
(SC 2.5.5). Exercise the change by narrating it as a screen-reader user would hear it. On a diff with no user
interface, return clean. Cite the success criterion or guideline.
