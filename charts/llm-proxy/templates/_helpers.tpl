{{- define "llm-proxy.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end }}
{{- define "llm-proxy.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "llm-proxy.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}
{{- define "llm-proxy.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "llm-proxy.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
{{- define "llm-proxy.selectorLabels" -}}
app.kubernetes.io/name: {{ include "llm-proxy.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
{{- define "llm-proxy.secretName" -}}{{ default (printf "%s-secrets" (include "llm-proxy.fullname" .)) .Values.secrets.existingSecret }}{{- end }}
{{- define "llm-proxy.databaseKey" -}}{{- if and .Values.postgresql.enabled (not .Values.secrets.existingSecret) -}}DATABASE_URL{{- else -}}{{ .Values.secrets.keys.databaseUrl }}{{- end -}}{{- end }}
{{- define "llm-proxy.databaseUrl" -}}{{- if .Values.postgresql.enabled -}}postgres://{{ .Values.postgresql.username }}:{{ .Values.postgresql.password }}@{{ include "llm-proxy.fullname" . }}-postgres:5432/{{ .Values.postgresql.database }}{{- else -}}{{ required "secrets.values.databaseUrl is required when PostgreSQL and existingSecret are not configured" .Values.secrets.values.databaseUrl }}{{- end -}}{{- end }}
{{- define "llm-proxy.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "llm-proxy.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end }}
