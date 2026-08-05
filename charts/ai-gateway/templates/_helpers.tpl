{{- define "ai-gateway.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end }}
{{- define "ai-gateway.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "ai-gateway.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}
{{- define "ai-gateway.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "ai-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
{{- define "ai-gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ai-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
{{- define "ai-gateway.secretName" -}}{{ default (printf "%s-secrets" (include "ai-gateway.fullname" .)) .Values.secrets.existingSecret }}{{- end }}
{{- define "ai-gateway.databaseKey" -}}{{- if and .Values.postgresql.enabled (not .Values.secrets.existingSecret) -}}DATABASE_URL{{- else -}}{{ .Values.secrets.keys.databaseUrl }}{{- end -}}{{- end }}
{{- define "ai-gateway.databaseUrl" -}}{{- if .Values.postgresql.enabled -}}postgres://{{ .Values.postgresql.username }}:{{ .Values.postgresql.password }}@{{ include "ai-gateway.fullname" . }}-postgres:5432/{{ .Values.postgresql.database }}{{- else -}}{{ required "secrets.values.databaseUrl is required when PostgreSQL and existingSecret are not configured" .Values.secrets.values.databaseUrl }}{{- end -}}{{- end }}
{{- define "ai-gateway.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "ai-gateway.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end }}
