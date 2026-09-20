export const RESEARCH_DISCLAIMER =
  'WoundCare Demo is a La Trobe University research prototype. It is not a medical device, not for clinical use, and does not replace professional wound assessment.';

export const SHORT_DISCLAIMER =
  'Research prototype · not for clinical use · does not replace professional assessment';

export const CONSENT_TEXT =
  'I understand this app is for research demonstration only. Results are not medical advice and must not be used for diagnosis or treatment decisions.';

export const STEPS = [
  {
    title: 'Capture & analyse',
    description: 'Photograph the wound. OpenCV estimates tissue colours and wound area.',
  },
  {
    title: 'Location',
    description: 'Select where the wound is on the body.',
  },
  {
    title: 'Questions',
    description: 'Answer short questions about duration, exudate, and infection signs.',
  },
  {
    title: 'Result',
    description: 'View a transparent, rule-based demo assessment and next-step guidance.',
  },
] as const;
